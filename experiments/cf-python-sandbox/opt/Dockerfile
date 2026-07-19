# Raw-container Python execution images — isolates each cold-start optimization lever.
# Base: python:3.11-slim (Debian, glibc -> manylinux wheels, no compilation).
FROM python:3.11-slim AS dsbase
# Inject host CA (env is behind a TLS-intercepting proxy) so pip can verify TLS.
COPY host-ca.crt /usr/local/share/ca-certificates/host-proxy.crt
ENV PIP_CERT=/usr/local/share/ca-certificates/host-proxy.crt \
    SSL_CERT_FILE=/usr/local/share/ca-certificates/host-proxy.crt \
    PIP_NO_CACHE_DIR=1 MPLBACKEND=Agg MPLCONFIGDIR=/opt/mpl PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir numpy pandas matplotlib
COPY server_exec.py server_ipython.py /app/
WORKDIR /app
EXPOSE 3000

# ---- raw: unoptimized minimal (NO bytecode precompile, NO font-cache prebake) ----
FROM dsbase AS raw
ENTRYPOINT ["python", "/app/server_exec.py"]

# ---- opt: + precompiled bytecode (site-packages) + prebaked matplotlib font cache ----
FROM dsbase AS opt
RUN python -m compileall -q /usr/local/lib/python3.11/site-packages /app || true
RUN mkdir -p /opt/mpl && python -c "import matplotlib; matplotlib.use('Agg'); \
    import matplotlib.pyplot as plt; plt.plot([0,1]); plt.savefig('/tmp/w.png')" && ls -la /opt/mpl
ENTRYPOINT ["python", "/app/server_exec.py"]

# ---- opt-ipython: opt + IPython (for the 'IPython overhead in a minimal container' comparison) ----
FROM opt AS opt-ipython
RUN pip install --no-cache-dir ipython
RUN python -m compileall -q /usr/local/lib/python3.11/site-packages || true
ENTRYPOINT ["python", "/app/server_ipython.py"]
