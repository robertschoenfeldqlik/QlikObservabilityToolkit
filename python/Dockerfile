# Single image, three entrypoints. Pick the exporter at `docker run` time
# by overriding the command:
#
#   docker run ... talend-tmc-python-exporters business_exporter.py
#   docker run ... talend-tmc-python-exporters engine_log_scraper.py
#   docker run ... talend-tmc-python-exporters qvd_exporter.py
#
# python:3.12-slim keeps the image small (~140 MB) and includes the SSL
# CA bundle we need for TMC + Qlik Cloud over HTTPS.

FROM python:3.12-slim AS runtime

WORKDIR /app

# tini gives us proper PID-1 signal handling — exporters trap SIGTERM and
# we want `docker stop` to deliver it cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bring the code in.
COPY common /app/common
COPY exporters /app/exporters

# Non-root.
RUN groupadd --system app && useradd --system --gid app --no-create-home --home /app app \
    && mkdir -p /var/lib/qvd-exporter /etc/qvd-exporter \
    && chown -R app:app /app /var/lib/qvd-exporter /etc/qvd-exporter
USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_FORMAT=json \
    LOG_LEVEL=info

ENTRYPOINT ["/usr/bin/tini", "--", "python", "-u"]
CMD ["exporters/business_exporter.py"]

LABEL org.opencontainers.image.title="Talend TMC Python exporters"
LABEL org.opencontainers.image.description="Business / Remote Engine / Qlik Cloud QVD exporters for the Qlik Observability Toolkit observability stack."
LABEL org.opencontainers.image.licenses="MIT"
