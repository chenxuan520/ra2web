"""Validity tests for real-engine tactic report summarization (not strength evidence)."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('tactic_ai', Path(__file__).with_name('summarize-ai-tactic.py'))
tactic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tactic)
CANDIDATE = 'b' * 40


def raw_report():
    matches = []
    for a, b, m, seed, swapped in sorted(tactic.schedule_keys('pilot')):
        matches.append(dict(candidateCountry=a, baselineCountry=b, map=m + '.map', seed=seed, swapped=swapped,
            result='draw', reason='tick-limit', ticks=27000, mapSha256='a' * 64, terrainSha256='c' * 64,
            telemetry=dict(errorCount=0), startingLocations=[dict(x=0, y=0), dict(x=10, y=10)][::(-1 if swapped else 1)],
            candidatePlayerName='p2' if swapped else 'p1', baselinePlayerName='p1' if swapped else 'p2'))
    return dict(candidate=dict(commit=CANDIDATE, profile='brutal', dirty=False),
                baseline=dict(commit=tactic.CONTROL, profile='brutal'), engineCommit='d' * 40,
                engineDirty=False, settings=tactic.SETTINGS, resources=dict(iniSha256='e' * 64), matches=matches)


class TacticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'raw.json'

    def assess(self, report):
        self.path.write_text(json.dumps(report))
        return tactic.verify([self.path], CANDIDATE)

    def test_complete_draws_are_valid_but_not_a_strength_improvement(self):
        result = self.assess(raw_report())
        self.assertEqual(result['totals']['draws'], 8)
        self.assertEqual(result['totals']['scoreWithHalfDraws'], .5)
        self.assertFalse(result['screeningPositive'])
        self.assertFalse(result['qualified'])

    def test_development_schedule_is_balanced_between_country_roles(self):
        keys = tactic.schedule_keys('development')
        self.assertEqual(len(keys), 96)
        for a, b, m, seed, swapped in keys:
            self.assertIn((b, a, m, seed, swapped), keys)

    def test_missing_feature_data_stays_missing(self):
        result = self.assess(raw_report())
        observed = result['games'][0]['observations'][0]
        self.assertIsNone(observed['produced']['DOG'])
        self.assertIsNone(observed['tankShots'])
        self.assertIsNone(observed['maxSampledEscort'])

    def test_errors_missing_and_duplicate_games_are_never_draws(self):
        for mode in ('error', 'missing', 'duplicate', 'duration'):
            report = raw_report()
            if mode == 'error': report['matches'][0]['telemetry']['errorCount'] = 1
            if mode == 'missing': report['matches'].pop()
            if mode == 'duplicate': report['matches'][-1] = copy.deepcopy(report['matches'][0])
            if mode == 'duration': report['matches'][0]['ticks'] = 1000
            with self.assertRaises(ValueError): self.assess(report)

    def test_unequal_swaps_versions_and_rules_are_rejected(self):
        for mode in ('spawn', 'version', 'dirty', 'handicap', 'resource'):
            report = raw_report()
            if mode == 'spawn': report['matches'][0]['startingLocations'] = []
            if mode == 'version': report['candidate']['commit'] = 'f' * 40
            if mode == 'dirty': report['engineDirty'] = True
            if mode == 'handicap': report['settings'] = {**report['settings'], 'credits': 20000}
            if mode == 'resource': report['matches'][0]['mapSha256'] = 'f' * 64
            with self.assertRaises(ValueError): self.assess(report)


if __name__ == '__main__':
    unittest.main()
