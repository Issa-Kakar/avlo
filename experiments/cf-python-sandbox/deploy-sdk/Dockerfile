FROM docker.io/cloudflare/sandbox:0.12.1-python
# most-optimized SDK config: python-only pool of 1, no JS/TS prewarm
ENV PYTHON_POOL_MIN_SIZE=1
ENV JAVASCRIPT_POOL_MIN_SIZE=0
ENV TYPESCRIPT_POOL_MIN_SIZE=0
