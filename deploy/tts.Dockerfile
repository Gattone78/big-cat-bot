# Chatterbox-TTS-Server (devnen) — no published container image exists, so this
# builds one. It mirrors the repo's own NVIDIA Dockerfile.cu128 (torch 2.9+cu128,
# which carries sm_120 Blackwell kernels for the RTX PRO 6000) with one change:
# the application code comes from a pinned git clone instead of `COPY . .`, so
# the image builds straight from this deploy/ directory with no manual clone.
#
#   sudo nerdctl compose build tts        (or: compose up -d --build tts)
#
# To pick up a newer upstream release, bump CHATTERBOX_REF and rebuild.
FROM docker.io/nvidia/cuda:12.8.1-runtime-ubuntu22.04

ARG CHATTERBOX_REF=v2.0.0

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive
# Hugging Face cache inside the container (mounted as a named volume in compose)
ENV HF_HOME=/app/hf_cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsndfile1 \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    python3-venv \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/bin/python3 /usr/bin/python

# Application code at a pinned tag (upstream uses COPY from a local checkout)
RUN git clone --depth 1 --branch ${CHATTERBOX_REF} \
    https://github.com/devnen/Chatterbox-TTS-Server.git /app
WORKDIR /app

# Same install sequence as upstream Dockerfile.cu128:
# 1. requirements install torch 2.9.0+cu128 (sm_120 Blackwell) + server deps
# 2. chatterbox with --no-deps so pip cannot downgrade torch
RUN python3 -m pip install --no-cache-dir --upgrade pip && \
    python3 -m pip install --no-cache-dir -r requirements-nvidia-cu128.txt && \
    python3 -m pip install --no-cache-dir --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0 && \
    python3 -m pip install --no-cache-dir "protobuf>=4.25.0"

RUN mkdir -p model_cache reference_audio outputs voices logs hf_cache

EXPOSE 8004

CMD ["python3", "server.py"]
