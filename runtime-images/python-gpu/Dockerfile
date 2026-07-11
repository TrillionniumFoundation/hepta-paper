FROM hepta/python-scientific:0.13.0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --requirement /tmp/requirements.lock \
 && python -c "import cupy,numpy,pandas,scipy,matplotlib; assert cupy.cuda.runtime.runtimeGetVersion() >= 12000"
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_runtime/lib
WORKDIR /work
