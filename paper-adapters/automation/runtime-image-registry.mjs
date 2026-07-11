export const AUTOMATION_RUNTIME_IMAGES = Object.freeze({
  python: Object.freeze({ image: 'hepta/python-scientific:0.13.0', executable: 'python3' }),
  pythonGpu: Object.freeze({ image: 'hepta/python-gpu:0.13.0', executable: 'python' }),
  r: Object.freeze({ image: 'hepta/r-scientific:0.13.0', executable: 'Rscript' }),
});

export function runtimeImagesForCampaign({ gpu = false } = {}) {
  return Object.freeze({
    python: gpu ? AUTOMATION_RUNTIME_IMAGES.pythonGpu : AUTOMATION_RUNTIME_IMAGES.python,
    r: AUTOMATION_RUNTIME_IMAGES.r,
  });
}
