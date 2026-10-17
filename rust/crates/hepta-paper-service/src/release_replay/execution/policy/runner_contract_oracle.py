import importlib, json, os, pathlib, sys, hashlib
root = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2])
os.umask(0o077)
sys.dont_write_bytecode = True
sys.path.insert(0, str(source))
module = importlib.import_module('paperctl_modules.paper_production_runner_execution_contract_artifact_queue')
request = json.load(sys.stdin)
report = module.build_runner_execution_contract_artifact_queue(
    request['target'], request['authoring'], request['upstream'], request['label'],
    root, request['materialize'], request['createdAt'])
files = []
for path in sorted(root.rglob('*')):
    if path.is_file() and not path.is_symlink():
        raw = path.read_bytes()
        files.append({'path':str(path.relative_to(root)), 'bytesHex':raw.hex(),
            'sha256':'sha256:'+hashlib.sha256(raw).hexdigest(), 'mode':path.stat().st_mode & 0o777})
print(json.dumps({'report':report, 'files':files}, sort_keys=True))
