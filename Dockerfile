FROM node:24-bookworm

# The app's first-boot seed draws covers/avatars with Python PIL and
# generates demo audio/video with ffmpeg.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pil ffmpeg fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8077

# Icons are drawn fresh (they are not in git), then the seed rebuilds the
# demo catalogue (covers, avatars, audio, database) before serving.
CMD ["sh", "-c", "python3 tools/gen_icons.py && cp -f public/icons/apple-touch-icon.png public/apple-touch-icon.png; node seed.js; node server.js"]
