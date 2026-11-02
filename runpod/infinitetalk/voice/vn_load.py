import os
from pathlib import Path
from vieneu._v3_turbo_engine import onnx_runtime_lite as m
_orig = m.OnnxV3LiteEngine._fetch
def _fetch(repo, files, subfolder):
    if "MOSS-Audio-Tokenizer" in repo:
        return Path(os.path.abspath("real/codec"))
    return _orig(repo, files, subfolder)
m.OnnxV3LiteEngine._fetch = staticmethod(_fetch)
from vieneu import Vieneu
def load():
    return Vieneu(onnx_dir=os.path.abspath("real/model/onnx_update"))
