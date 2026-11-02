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

# Icons are drawn fresh (they are not in git) before serving. The seed
# is NOT run here: server.js restores the record book from storage
# first and only seeds when no book exists anywhere — running the seed
# in the start command rebuilt the demo catalogue on EVERY container
# start and wiped artists' profiles and songs on every deploy (owner
# report, Nov 1, 2026; root-caused the same evening).
CMD ["sh", "-c", "python3 tools/gen_icons.py && cp -f public/icons/apple-touch-icon.png public/apple-touch-icon.png; node server.js"]
