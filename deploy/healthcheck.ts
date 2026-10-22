export {};

const protocol = process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE ? 'https' : 'http';
try {
    const response = await fetch(`${protocol}://127.0.0.1:${process.env.HTTP_PORT ?? '8080'}/healthz`, {
        signal: AbortSignal.timeout(8000),
        tls: { rejectUnauthorized: false },
    });
    process.exit(response.ok ? 0 : 1);
}
catch {
    process.exit(1);
}
