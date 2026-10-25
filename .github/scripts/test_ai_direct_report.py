"""Direct-match screening must not turn draws or incomplete evidence into improvement."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('direct_ai', Path(__file__).with_name('summarize-ai-direct.py'))
direct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(direct)
PLAN = json.loads((Path(__file__).resolve().parents[2] / 'docs/ai-vanilla-evaluation-plan.json').read_text())


def report(label='development', result='candidate-win'):
    config = {k: 'a' * 64 for k in direct.paired.COMPARABLE}
    config.update(PLAN['settings'], candidateCommit='b' * 40, baselineCommit=PLAN['controlCommit'],
                  baselineProfile='brutal', countries=PLAN['countries'])
    scenarios = [(m, int(s)) for m, s in (v.split(':') for v in PLAN['scenarioSets'][label].values())]
    games = [dict(candidateCountry=a, baselineCountry=b, map=m + '.map', seed=s, swapped=swap,
                  result=result) for a in PLAN['countries'] for b in PLAN['countries'] if a != b
             for m, s in scenarios for swap in (False, True)]
    return dict(config=config, scenarios=scenarios, games=games, totals=direct.paired.counts(games))


class DirectTests(unittest.TestCase):
    def test_all_draws_and_balanced_results_do_not_pass(self):
        for balanced in (False, True):
            value = report(result='draw')
            if balanced:
                for i, game in enumerate(value['games']):
                    game['result'] = 'candidate-win' if i % 2 else 'baseline-win'
                value['totals'] = direct.paired.counts(value['games'])
            result = direct.direct_assessment([value], PLAN)
            self.assertEqual(result['scoreWithHalfDraws'], .5)
            self.assertFalse(result['screeningPositive'])
            self.assertFalse(result['qualified'])

    def test_positive_development_screen_is_not_qualification(self):
        result = direct.direct_assessment([report()], PLAN)
        self.assertTrue(result['screeningPositive'])
        self.assertFalse(result['qualified'])
        self.assertIsNone(result['scoreInterval'])
        self.assertEqual(result['verdict'], 'development-positive')

    def test_complete_registered_qualification_is_required_for_interval(self):
        reports = [report(label) for label in PLAN['qualificationSets']]
        result = direct.direct_assessment(reports, PLAN)
        self.assertTrue(result['qualified'])
        self.assertEqual(result['totals']['games'], 1296)
        self.assertEqual(result['scoreInterval'], [1, 1])

    def test_incomplete_or_duplicated_games_are_rejected(self):
        for mode in ('missing', 'duplicate', 'error'):
            value = report()
            if mode == 'missing': value['games'].pop()
            if mode == 'duplicate': value['games'][-1] = copy.deepcopy(value['games'][0])
            if mode == 'error': value['games'][0]['result'] = 'error'
            with self.assertRaises(ValueError): direct.direct_assessment([value], PLAN)

    def test_mixed_candidates_engines_or_profiles_are_rejected(self):
        first = report('qualification_a')
        for key in ('candidateCommit', 'engineSourceSha256', 'baselineProfile'):
            other = report('qualification_b')
            other['config'][key] = 'different'
            with self.assertRaises(ValueError): direct.direct_assessment([first, other], PLAN)


if __name__ == '__main__':
    unittest.main()
