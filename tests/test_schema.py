import copy
import json
import unittest

import test_native as native_tests
from host import SCHEMA


def window(count, identifier='window-1', prefix='current'):
    return {'id': identifier, 'segments': [
        {'id': f'{prefix}:{i}', 'speaker': 'A', 'text': f'Synthetic sentence {i}.'}
        for i in range(count)]}


class SchemaTests(unittest.TestCase):
    def test_exact_anchor_count_is_constrained_during_generation(self):
        for count in [1, 3, 17, 512]:
            with self.subTest(count=count):
                current = window(count)
                engine, calls = native_tests.NativeTests().engine()
                engine.translate(current, [], 'ru')
                schema = calls[-1][1]['outputSchema']
                segments = schema['properties']['segments']
                self.assertEqual(segments['minItems'], count)
                self.assertEqual(segments['maxItems'], count)
                self.assertEqual(schema['properties']['windowId']['enum'], [current['id']])
                self.assertEqual(segments['items']['properties']['id']['enum'],
                                 [item['id'] for item in current['segments']])

    def test_reused_thread_refreshes_schema_for_growing_and_shrinking_windows(self):
        engine, calls = native_tests.NativeTests().engine()
        context = [{'id': 'context:0', 'speaker': 'B', 'text': 'Context only.'}]
        previous = [{'id': 'context:0', 'text': 'Earlier translation.'}]
        for index, count in enumerate([2, 8, 1]):
            current = window(count, f'window-{index+1}', f'source-{index}')
            engine.translate(current, context, 'ru', previous)
            params = calls[-1][1]
            schema = params['outputSchema']
            self.assertEqual(schema['properties']['windowId']['enum'], [current['id']])
            self.assertEqual(schema['properties']['segments']['minItems'], count)
            self.assertEqual(schema['properties']['segments']['maxItems'], count)
            self.assertEqual(schema['properties']['segments']['items']['properties']['id']['enum'],
                             [item['id'] for item in current['segments']])
            self.assertEqual(json.loads(params['input'][0]['text'])['previous'], previous)
        self.assertEqual(sum(method == 'thread/start' for method, _ in calls), 1)

    def test_per_turn_schema_never_mutates_template_or_other_requests(self):
        original = copy.deepcopy(SCHEMA)
        engine, calls = native_tests.NativeTests().engine()
        engine.translate(window(3), [], 'ru')
        first = calls[-1][1]['outputSchema']
        engine.translate(window(1, 'window-2'), [], 'ru')
        second = calls[-1][1]['outputSchema']
        self.assertEqual(SCHEMA, original)
        self.assertIsNot(first, second)
        self.assertEqual(first['properties']['segments']['minItems'], 3)
        self.assertEqual(second['properties']['segments']['minItems'], 1)
        first['properties']['segments']['items']['properties']['id']['enum'].append('mutated')
        self.assertNotIn('mutated', second['properties']['segments']['items']['properties']['id']['enum'])
        self.assertEqual(SCHEMA, original)

    def test_unusually_long_ids_do_not_exceed_structured_output_enum_limits(self):
        for count, prefix_length, constrained in [(250, 90, True), (251, 50, True),
                                                   (251, 90, False), (512, 90, False)]:
            with self.subTest(count=count, prefix_length=prefix_length):
                current = window(count, prefix='x' * prefix_length)
                engine, calls = native_tests.NativeTests().engine()
                engine.translate(current, [], 'ru')
                segments = calls[-1][1]['outputSchema']['properties']['segments']
                self.assertEqual(segments['minItems'], count)
                self.assertEqual(segments['maxItems'], count)
                self.assertEqual('enum' in segments['items']['properties']['id'], constrained)

    def test_wrong_count_still_fails_without_retry_and_reports_only_numeric_metadata(self):
        current = window(3)
        caption = 'Synthetic private caption must not appear in the error.'
        current['segments'][0]['text'] = caption
        for segments in [None, {}, [], [{'id': 'current:0', 'text': 'Translation'}],
                         [{'id': f'current:{i}', 'text': 'Translation'} for i in range(4)]]:
            with self.subTest(segments=segments):
                engine, calls = native_tests.NativeTests().engine(
                    {'windowId': current['id'], 'segments': segments})
                with self.assertRaises(RuntimeError) as caught:
                    engine.translate(current, [], 'ru')
                message = str(caught.exception)
                self.assertIn('Incorrect number of translation anchors', message)
                self.assertIn('expected 3', message)
                self.assertIn(f'received {len(segments) if isinstance(segments, list) else "non-array"}', message)
                self.assertNotIn(caption, message)
                self.assertTrue(engine.cancelled.is_set())
                self.assertIsNone(engine.thread)
                self.assertEqual(sum(method == 'turn/start' for method, _ in calls), 1)

    def test_equal_count_does_not_hide_duplicate_or_context_only_ids(self):
        current = window(2)
        for ids in [['current:0', 'current:0'], ['current:0', 'context:0']]:
            with self.subTest(ids=ids):
                engine, calls = native_tests.NativeTests().engine({'windowId': current['id'],
                    'segments': [{'id': ident, 'text': 'Translation'} for ident in ids]})
                with self.assertRaises(RuntimeError):
                    engine.translate(current, [{'id': 'context:0', 'text': 'Not in window.'}], 'ru')
                self.assertTrue(engine.cancelled.is_set())
                self.assertEqual(sum(method == 'turn/start' for method, _ in calls), 1)


if __name__ == '__main__':
    unittest.main()
