"""Resolve one preregistered scenario for the existing 432-game CI layout."""
import argparse
import json
import re
from pathlib import Path


def scenario(plan, name, shard):
    sets = plan['scenarioSets']
    seen = set()
    for label, entries in sets.items():
        if set(entries) != {'short', 'medium', 'long'}:
            raise ValueError(f'Incomplete scenario set: {label}')
        for value in entries.values():
            if not re.fullmatch(r'[a-z0-9]+:[0-9]+', value):
                raise ValueError(f'Invalid scenario: {value}')
            if value in seen:
                raise ValueError(f'Reused map/seed: {value}')
            seen.add(value)
    if name not in sets or shard not in sets[name]:
        raise ValueError('Unknown evaluation set or shard')
    return sets[name][shard]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--set', required=True)
    parser.add_argument('--shard', required=True)
    args = parser.parse_args()
    print(scenario(json.loads(args.plan.read_text()), args.set, args.shard))
