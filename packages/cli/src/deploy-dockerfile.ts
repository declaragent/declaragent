export interface DockerfileConfig {
  binary?: string;
}

export function renderDockerfile(cfg: DockerfileConfig = {}): string {
  const binary = cfg.binary ?? 'declaragent-linux-x64';
  return `FROM alpine:3.19
ARG BINARY=${binary}
COPY bin/\${BINARY} /usr/local/bin/declaragent
COPY config /etc/declaragent
RUN chmod +x /usr/local/bin/declaragent \\
  && addgroup -S agent && adduser -S agent -G agent
USER agent
ENV DECLARAGENT_CONFIG_DIR=/etc/declaragent
EXPOSE 8787 9464
ENTRYPOINT ["/usr/local/bin/declaragent", "run"]
`;
}

export function renderDockerignore(): string {
  return `.git
.github
node_modules
dist
.declaragent/deploy
**/*.test.ts
**/*.spec.ts
.env
.env.*
!.env.example
*.log
.DS_Store
`;
}
