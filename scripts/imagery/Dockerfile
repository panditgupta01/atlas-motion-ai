# Builds the prepared Sentinel-2 imagery regions once, into the "imagery" volume (see docker-compose.yml).
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir rasterio==1.5.2 mgrs==1.5.4 numpy==2.5.3 pillow==12.3.0 packaging==25.0
WORKDIR /bake
COPY bake_sentinel2.py prepare-regions.sh ./
CMD ["sh", "prepare-regions.sh", "/regions"]
