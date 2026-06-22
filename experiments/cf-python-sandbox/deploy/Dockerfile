# Multi-stage: install + strip test suites in builder, copy lean site-packages to runtime.
FROM python:3.11-slim AS builder
COPY host-ca.crt /usr/local/share/ca-certificates/host-proxy.crt
ENV PIP_CERT=/usr/local/share/ca-certificates/host-proxy.crt PIP_NO_CACHE_DIR=1
RUN pip install --no-cache-dir numpy pandas matplotlib
# Strip baked-in test suites + stray bytecode (safe: not imported at runtime), then precompile.
RUN set -eux; cd /usr/local/lib/python3.11/site-packages; \
    find . -type d \( -name tests -o -name test \) -prune -exec rm -rf {} +; \
    find . -name "*.pyc" -delete; \
    rm -rf pandas/tests numpy/*/tests matplotlib/tests 2>/dev/null || true; \
    python -m compileall -q .

FROM python:3.11-slim AS runtime
ENV MPLBACKEND=Agg MPLCONFIGDIR=/opt/mpl PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY server.py /app/server.py
RUN python -m compileall -q /app && mkdir -p /opt/mpl && \
    python -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([0,1]); plt.savefig('/tmp/w.png')"
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["python", "/app/server.py"]
