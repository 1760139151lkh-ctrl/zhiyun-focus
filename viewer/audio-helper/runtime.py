"""Paths for optional downloaded assets; never depends on an agent runtime."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HOME = ROOT / '.runtime' / 'audio'
LEGACY_HOME = ROOT / 'work' / 'immersive_next' / 'audio-lab'


def has_assets(home):
    return ((home / 'models/MossFormer2_SE_48K/last_best_checkpoint.pt').is_file()
            and (home / 'cv-runtime/models/mossformer2_se/mossformer2_se_wrapper.py').is_file())


def runtime_home():
    configured = os.environ.get('ZJF_AUDIO_HOME')
    if configured:
        return Path(os.path.expandvars(configured)).expanduser().resolve()
    # Preserve an existing installation while new clones use a documented path.
    if not has_assets(DEFAULT_HOME) and has_assets(LEGACY_HOME):
        return LEGACY_HOME
    return DEFAULT_HOME


def runtime_python():
    environment = runtime_home() / 'cv-env'
    candidate = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    return candidate if candidate.is_file() else Path(sys.executable)
