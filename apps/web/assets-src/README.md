# Source assets (not shipped, not committed)

Raw inputs for offline asset builds live here and are ignored by git: Adobe's Mixamo
terms allow characters and animations inside a game but not redistribution of the
raw files on their own, so they must not be served from `public/` or published in
the repository.

- `characters/raw/*.fbx`: Mixamo animation clips, the input to
  `scripts/fbx_to_glb.py` and `scripts/build_operator_glb.py`, which produce the
  shipped `public/characters/glb/operator.glb`. Download them from mixamo.com with
  your own Adobe account to rebuild the operator.
