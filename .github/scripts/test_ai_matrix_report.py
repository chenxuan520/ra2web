import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('report', Path(__file__).with_name('summarize-ai-matrix.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class CountryReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        countries = ['Americans', 'Alliance', 'French', 'Germans', 'British', 'Africans', 'Arabs', 'Confederation', 'Russians']
        settings = dict(maxTicks=27000, sampleTicks=900, credits=10000, unitCount=0,
                        engineDifficulty=4, pairedSpawnSwap=True, pairedPlayerOrderSwap=True,
                        shortGame=True, superWeapons=False, crates=False, gameSpeed=3,
                        engineStalemateDetection=False, simulationTicksPerSecond=15)
        for index, map_name in enumerate(['mp08t2', 'tn01t2', 'mp11t2']):
            shard = self.root / f'shard-{index}'
            (shard / 'jobs').mkdir(parents=True)
            scenario = dict(map=map_name, seed=index + 1, mapSha256='map', terrainSha256='terrain')
            config = dict(candidateCommit='new', baselineCommit='old', engineCommit='engine',
                          candidateProfile='brutal', baselineProfile='brutal', countries=countries,
                          iniSha256='rules', customIniSha256='custom', scenarios=[scenario],
                          **{k: settings[k] for k in ['maxTicks', 'sampleTicks', 'credits', 'unitCount']})
            fingerprint = hashlib.sha256(json.dumps(config, separators=(',', ':')).encode()).hexdigest()
            jobs = []
            for country in countries:
                for opponent in countries:
                    if country == opponent:
                        continue
                    job = dict(id=f'{country}-vs-{opponent}', candidateCountry=country, baselineCountry=opponent)
                    jobs.append(job)
                    matches = [dict(candidateCountry=country, baselineCountry=opponent, map=map_name + '.map',
                                    seed=index + 1, mapSha256='map', terrainSha256='terrain', swapped=swap,
                                    result='candidate-win', reason='engine-victory-conditions', ticks=5000,
                                    telemetry=dict(errorCount=0)) for swap in [False, True]]
                    data = dict(candidate=dict(commit='new', profile='brutal', dirty=False),
                                baseline=dict(commit='old', profile='brutal'), engineCommit='engine', engineDirty=False,
                                settings=settings, resources=dict(iniSha256='rules', customIniSha256='custom'), matches=matches)
                    path = shard / 'jobs' / (job['id'] + '.json')
                    path.write_text(json.dumps(data))
                    receipt = dict(fingerprint=fingerprint, reportSha256=hashlib.sha256(path.read_bytes()).hexdigest())
                    path.with_suffix('.verified.json').write_text(json.dumps(receipt))
            (shard / 'manifest.json').write_text(json.dumps(dict(config=config, fingerprint=fingerprint, countryLabels={c: c for c in countries}, jobs=jobs)))
            (shard / 'summary.json').write_text(json.dumps(dict(fingerprint=fingerprint, failedJobs={}, total=dict(pending=0, errors=0))))

    def test_complete_matrix_is_counted_once(self):
        report.aggregate(self.root, self.root / 'result')
        data = json.loads((self.root / 'result/results.json').read_text())
        self.assertEqual(data['totals'], dict(wins=432, losses=0, draws=0, games=432, winRate=1.0))
        self.assertEqual(data['matrix']['Americans']['French']['games'], 6)

    def test_missing_scenario_is_rejected(self):
        (self.root / 'shard-1/manifest.json').unlink()
        with self.assertRaisesRegex(ValueError, 'three scenario'):
            report.aggregate(self.root, self.root / 'result')

    def test_changed_report_requires_matching_receipt(self):
        path = self.root / 'shard-0/jobs/Americans-vs-French.json'
        path.write_text(path.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'receipt'):
            report.aggregate(self.root, self.root / 'result')

    def test_manifest_change_is_not_silently_accepted(self):
        path = self.root / 'shard-0/manifest.json'
        data = json.loads(path.read_text()); data['config']['credits'] = 20000
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            report.aggregate(self.root, self.root / 'result')

    def test_partial_scenario_is_not_a_success(self):
        path = self.root / 'shard-0/summary.json'
        data = json.loads(path.read_text()); data['total']['pending'] = 1
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'pending'):
            report.aggregate(self.root, self.root / 'result')

    def test_runtime_error_is_not_counted_as_a_win(self):
        path = self.root / 'shard-0/jobs/Americans-vs-French.json'
        data = json.loads(path.read_text()); data['matches'][0]['telemetry']['errorCount'] = 1
        path.write_text(json.dumps(data))
        receipt = path.with_suffix('.verified.json'); proof = json.loads(receipt.read_text())
        proof['reportSha256'] = hashlib.sha256(path.read_bytes()).hexdigest(); receipt.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'Invalid game'):
            report.aggregate(self.root, self.root / 'result')


if __name__ == '__main__':
    unittest.main()
