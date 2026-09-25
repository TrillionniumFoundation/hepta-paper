#!/usr/bin/env python3
"""Rebind archived source decisions to a current Git tree, never to merge ancestry.

This is content observation and conservative source selection, not behavioural
parity, independent review, deployment qualification or permission to merge.
Missing archived Git objects remain explicit incomplete observations.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import hashlib
import json
import pathlib
import re
import subprocess

ARCHIVE = pathlib.Path('docs/migration/consolidation-20260922')
OID = re.compile(r'[0-9a-f]{40}')


def git(root: pathlib.Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '--no-pager', *args], cwd=root, stderr=subprocess.PIPE)


def digest(raw: bytes) -> str:
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def tree(root: pathlib.Path, commit: str) -> dict[str, dict[str, str]]:
    files = {}
    for record in git(root, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        header, path = record.split(b'\t', 1)
        mode, kind, oid = header.decode().split()
        files[path.decode()] = {'mode': mode, 'kind': kind, 'gitBlob': oid}
    return files


def source_decision(old: str, selected: list[dict], previous: dict, policy: str) -> str:
    if policy == 'archived-not-runtime':
        return 'reject'
    if not selected or any(row['current'] is None for row in selected):
        return 'reference'
    if any(row['current']['gitBlob'] == old for row in selected):
        return 'absorb'
    if policy in ('retained-current', 'superseded') and all(
        previous.get(row['path'], {}).get('gitBlobCalculatedFromObservedWorkingBytes')
        == row['current']['gitBlob'] for row in selected
    ):
        return 'supersede'
    # A port or a later changed owner is not automatically semantically equal to
    # an old source merely because it has the same path or is a descendant.
    return 'reference'


def build_report(root: pathlib.Path, candidate: str, archive: pathlib.Path = ARCHIVE) -> dict:
    candidate = git(root, 'rev-parse', '--verify', candidate + '^{commit}').decode().strip()
    candidate_tree = git(root, 'rev-parse', candidate + '^{tree}').decode().strip()
    selected_tree = tree(root, candidate)
    snapshot = git(root, 'show', f'{candidate}:{archive}/remote-heads-before.txt')
    ledger_bytes = git(root, 'show', f'{candidate}:{archive}/final-source-decision-ledger.json.gz')
    ledger = json.loads(gzip.decompress(ledger_bytes))
    heads = []
    refs = set()
    for line in snapshot.decode().splitlines():
        oid, ref = line.split()
        if not OID.fullmatch(oid) or not ref.startswith('refs/heads/') or ref in refs:
            raise ValueError('malformed or duplicate archived head')
        refs.add(ref)
        heads.append((oid, ref))
    histories = {row['sourceRef'].replace('refs/remotes/origin/', 'refs/heads/'): row
                 for row in ledger['branchHistoryDecisions']}
    if any(ref not in refs for ref in histories):
        raise ValueError('historical decision references an uncaptured branch')
    source_rows = []
    missing = set()
    for row in ledger['sourceDecisions']:
        old = row['oldGitBlob']
        if not OID.fullmatch(old):
            raise ValueError('noncanonical archived source blob')
        try:
            available = git(root, 'cat-file', '-t', old).strip() == b'blob'
        except subprocess.CalledProcessError:
            available = False
        if not available:
            missing.add(old)
        paths = [{'path': path, 'current': selected_tree.get(path)} for path in row['newPaths']]
        source_rows.append({
            'id': row['id'], 'oldPath': row['oldPath'], 'oldGitBlob': old,
            'oldBlobAvailable': available, 'currentPaths': paths,
            'historicalPolicy': row['decision'],
            'decision': source_decision(old, paths, ledger['observedCurrentFiles'], row['decision'])
                if available else 'reference',
            'historicalRationale': row['rationale'],
            'scope': 'exact-source-selection-only-not-runtime-equivalence',
        })
    by_source = {row['id']: row for row in source_rows}
    if len(by_source) != len(source_rows):
        raise ValueError('duplicate historical source decision identity')
    comparisons = {}
    branches = []
    for tip, ref in heads:
        history = histories.get(ref)
        if history and history['oldTip'] != tip:
            raise ValueError('archived branch tip and source decision disagree')
        source_ids = history['sourceDecisionIds'] if history else []
        if any(identity not in by_source for identity in source_ids):
            raise ValueError('unknown source decision identity')
        if tip not in comparisons:
            try:
                old_tree = tree(root, tip)
                raw = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
                          '--name-status', '-z', tip, candidate, '--')
                tokens = raw.split(b'\0')[:-1]
                if len(tokens) % 2:
                    raise ValueError('noncanonical no-rename diff')
                changes = [(tokens[i].decode(), tokens[i + 1].decode()) for i in range(0, len(tokens), 2)]
                comparisons[tip] = {
                    'tree': git(root, 'rev-parse', tip + '^{tree}').decode().strip(),
                    'diffSha256': digest(raw), 'diffBytes': len(raw),
                    'allChangedPaths': len(changes),
                    'statusCounts': dict(sorted(collections.Counter(status for status, _ in changes).items())),
                    'rustChanges': [{'status': status, 'path': path,
                                     'old': old_tree.get(path), 'current': selected_tree.get(path)}
                                    for status, path in changes if path.endswith('.rs')],
                    'complete': True,
                }
            except subprocess.CalledProcessError:
                missing.add(tip)
                comparisons[tip] = {'complete': False, 'missingCommit': tip}
        comparison = comparisons[tip]
        dispositions = [by_source[identity]['decision'] for identity in source_ids]
        if comparison.get('tree') == candidate_tree:
            decision = 'absorb'
            reason = 'The complete observed tree is byte-identical; no history-based inference is used.'
        elif not comparison['complete']:
            decision = 'reference'
            reason = 'Retain the recorded tip; absent Git content cannot be certified or merged.'
        elif dispositions and all(value == 'reject' for value in dispositions):
            decision = 'reject'
            reason = 'All mapped old runtime variants are intentionally unselected; retain history only.'
        elif 'supersede' in dispositions:
            decision = 'supersede'
            reason = 'Select the unchanged reviewed successor paths, with exact per-source exceptions retained below; do not restore this whole historical tree.'
        else:
            decision = 'reference'
            reason = 'Preserve the complete content comparison and current per-source choices; ancestry, an unmapped delta or a compatibility port is not whole-tree absorption.'
        branches.append({'ref': ref, 'tip': tip, 'decision': decision, 'rationale': reason,
                         'sourceDecisionIds': source_ids, 'contentComparison': tip})
    missing_paths = sorted({row['path'] for source in source_rows for row in source['currentPaths']
                            if row['current'] is None})
    return {
        'kind': 'CurrentHistoricalSourceDispositionObservationV1', 'version': 1,
        'candidateCommit': candidate, 'candidateTree': candidate_tree,
        'inputs': {'archivedHeadsSha256': digest(snapshot), 'archivedLedgerSha256': digest(ledger_bytes)},
        'branchCount': len(branches), 'uniqueTipCount': len(comparisons),
        'sourceVariantCount': len(source_rows),
        'branchDispositionCounts': dict(sorted(collections.Counter(row['decision'] for row in branches).items())),
        'sourceDispositionCounts': dict(sorted(collections.Counter(row['decision'] for row in source_rows).items())),
        'completeContentObservation': not missing and not missing_paths,
        'missingObjects': sorted(missing), 'missingSelectedPaths': missing_paths,
        'branches': branches, 'sourceDecisions': source_rows, 'contentComparisons': comparisons,
        'authority': {'independentReviewVerified': False, 'behavioralParityAccepted': False,
                      'productionActivation': False, 'nodeRetirement': False, 'automaticMerge': False},
        'scope': 'Every archived head, including old ancestors; unique-tip observations are stored once. Changed current owners remain reference until separately reviewed. No old receipt qualifies this subject.',
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path.cwd())
    args = parser.parse_args()
    report = build_report(args.root.resolve(), args.candidate)
    args.output.write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['candidateCommit', 'candidateTree', 'branchCount',
          'uniqueTipCount', 'sourceVariantCount', 'completeContentObservation',
          'branchDispositionCounts', 'sourceDispositionCounts', 'missingObjects', 'missingSelectedPaths']}, sort_keys=True))


if __name__ == '__main__':
    main()
