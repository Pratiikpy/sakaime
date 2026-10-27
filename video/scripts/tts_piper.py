"""Synthesises a list of utterances with Piper, loading the voice once.

Input (stdin): JSON {"model": path, "length_scale": float, "items": [{"out": path, "text": str}]}
The voice is a public-domain Librivox recording (en_GB-cori-high); its model card is kept beside the model file.
"""
import json
import sys
import wave

from piper import PiperVoice, SynthesisConfig

job = json.load(sys.stdin)
voice = PiperVoice.load(job["model"])
config = SynthesisConfig(length_scale=job.get("length_scale", 1.0), noise_scale=0.55, noise_w_scale=0.7)
for item in job["items"]:
    with wave.open(item["out"], "wb") as wav:
        voice.synthesize_wav(item["text"], wav, syn_config=config)
    print("ok", item["out"], flush=True)
