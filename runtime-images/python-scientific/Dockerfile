FROM python:3.12.7-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --requirement /tmp/requirements.lock \
 && python -c "import numpy,pandas,scipy,statsmodels,sklearn,matplotlib,seaborn"
WORKDIR /work
