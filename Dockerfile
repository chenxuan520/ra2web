FROM debian:bookworm-slim AS pvpgn-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake zlib1g-dev && rm -rf /var/lib/apt/lists/*
COPY pvpgn-server /src/pvpgn
RUN cmake -S /src/pvpgn -B /build -DCMAKE_INSTALL_PREFIX=/opt/pvpgn -DWITH_D2CS=OFF -DWITH_D2DBS=OFF -DWITH_LUA=OFF && cmake --build /build --parallel 4 && ctest --test-dir /build --output-on-failure && cmake --install /build

FROM oven/bun:1.3.14-debian AS web-build
RUN apt-get update && apt-get install -y --no-install-recommends p7zip-full && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ts-redalert2/package.json ts-redalert2/bun.lock ./
RUN bun install --frozen-lockfile
COPY ts-redalert2/index.html ts-redalert2/vite.config.ts ts-redalert2/tsconfig*.json ./
COPY ts-redalert2/public ./public
COPY ts-redalert2/src ./src
COPY ts-redalert2/e2e ./e2e
COPY ts-redalert2/server ./server
COPY ts-redalert2/deploy ./deploy
COPY --from=pvpgn-build /opt/pvpgn /opt/pvpgn
RUN mkdir -p /tmp/opencode && bun run prepare:bundled /tmp/opencode/cdn && PVPGN_TEST_PREFIX=/opt/pvpgn RA2_PREPARED_CDN=/tmp/opencode/cdn bun run typecheck:entry && PVPGN_TEST_PREFIX=/opt/pvpgn RA2_PREPARED_CDN=/tmp/opencode/cdn bun run typecheck:server && PVPGN_TEST_PREFIX=/opt/pvpgn RA2_PREPARED_CDN=/tmp/opencode/cdn bun test && bun --bun vite build && test ! -e dist/cdn

FROM oven/bun:1.3.14-debian
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 zlib1g p7zip-full tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=pvpgn-build /opt/pvpgn /opt/pvpgn
COPY --from=web-build /app/dist ./dist
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/package.json /app/tsconfig.json ./
COPY --from=web-build /app/src ./src
COPY --from=web-build /app/deploy ./deploy
COPY --from=web-build /app/public/ini.mix ./public/ini.mix
COPY --from=web-build /app/public/res/ra2cd.mix ./public/res/ra2cd.mix
COPY --from=web-build /app/server ./server
COPY deploy/start.ts deploy/healthcheck.ts ./deploy/
COPY ts-redalert2/LICENSE ./licenses/RA2-LICENSE
COPY pvpgn-server/LICENSE ./licenses/PvPGN-LICENSE
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV HTTP_PORT=8080 STATIC_DIR=/app/dist ASSET_DIR=/data/cdn DATA_DIR=/data PVPGN_HOST=127.0.0.1 PVPGN_PORT=4005 AUTO_DOWNLOAD_ASSETS=false
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=10s --start-period=180s --retries=3 CMD ["bun", "/app/deploy/healthcheck.ts"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "/app/deploy/start.ts"]
