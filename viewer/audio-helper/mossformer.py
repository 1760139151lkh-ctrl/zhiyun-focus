# SPDX-License-Identifier: Apache-2.0
"""Production adapter for the pinned ClearerVoice-Studio MossFormer2 model.

Feature transforms follow ClearerVoice-Studio commit
6b3774dc79c46ae8bed2a4fa5f706f0ac8c75c61 (Apache-2.0).
Extracted from this project's offline integration: only the model-loading and
segment functions remain; local comparison files and experimental models are
not part of the runtime. See ../../LICENSES/Apache-2.0.txt.
"""
import numpy as np
import torch
import torchaudio

from runtime import runtime_home

torch.set_num_threads(4)
torch.manual_seed(17)
DEVICE = 'cuda'


def load_weights(model, name='MossFormer2_SE_48K'):
    checkpoint = runtime_home() / 'models' / name / 'last_best_checkpoint.pt'
    obj = torch.load(checkpoint, map_location='cpu', weights_only=True)
    state = obj.get('model', obj)
    state = {key.removeprefix('module.'): value for key, value in state.items()}
    result = model.load_state_dict(state, strict=True)
    model.eval().to(DEVICE)
    print(name, 'strict weights loaded', result, flush=True)
    return model


def moss_segment(model, samples):
    # Retain the accepted model's 16-bit Kaldi input scale and dither.
    audio = torch.from_numpy(np.asarray(samples * 32768, dtype=np.float32))
    features = torchaudio.compliance.kaldi.fbank(
        audio[None], dither=1.0, frame_length=40, frame_shift=8,
        num_mel_bins=60, sample_frequency=48000, window_type='hamming')
    delta = torchaudio.functional.compute_deltas(features.T)
    delta2 = torchaudio.functional.compute_deltas(delta)
    features = torch.cat([features, delta.T, delta2.T], dim=1)[None].to(DEVICE)
    mask = model(features)[-1].permute(2, 1, 0).detach().cpu()
    window = torch.hamming_window(1920, periodic=False)
    spectrum = torch.stft(audio, 1920, 384, 1920, window, center=False, return_complex=True)
    if spectrum.shape != mask.shape[:2]:
        raise ValueError('MossFormer2 spectrum and mask dimensions differ')
    masked = spectrum * mask[..., 0]
    return (torch.istft(masked, 1920, 384, 1920, window,
                       center=False, length=len(audio)) / 32768).numpy()
