'use strict';

const http = require('node:http');
const https = require('node:https');
const { acknowledgementHeaders, effectDigest } = require('./fencedGateway.service');

class FencedGatewayClientError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'FencedGatewayClientError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function normalizeHeaders(headers) {
    const normalized = {};
    for (const [name, value] of Object.entries(headers || {})) {
        normalized[name.toLowerCase()] = Array.isArray(value) ? value[0] : String(value);
    }
    return normalized;
}

function assertAcknowledgement(headers, expected) {
    const actual = normalizeHeaders(headers);
    const required = normalizeHeaders(acknowledgementHeaders(expected.operationId, expected.identity, expected.digest));
    for (const [name, value] of Object.entries(required)) {
        if (actual[name] !== value) {
            throw new FencedGatewayClientError(
                'Gateway acknowledgement mismatch: ' + name,
                'MESH_ACKNOWLEDGEMENT_MISMATCH',
                502
            );
        }
    }
}

function assertProof(body, expected) {
    const proof = body && body._ailliumProof;
    if (!proof || proof.operationId !== expected.operationId || proof.digest !== expected.digest || proof.status !== 'completed') {
        throw new FencedGatewayClientError('Gateway proof is missing or mismatched', 'MESH_PROOF_MISMATCH', 502);
    }
    for (const [field, value] of Object.entries(expected.identity)) {
        if (String(proof.identity && proof.identity[field]) !== String(value)) {
            throw new FencedGatewayClientError(
                'Gateway proof identity mismatch: ' + field,
                'MESH_PROOF_MISMATCH',
                502
            );
        }
    }
}

function buildHeaders(token, operationId, identity, digest) {
    return {
        'Content-Type': 'application/json',
        'X-Aillium-Desktop-Control': token,
        ...acknowledgementHeaders(operationId, identity, digest)
    };
}

function postJson(url, body, headers) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = Buffer.from(JSON.stringify(body));
        const request = (target.protocol === 'https:' ? https : http).request(
            target,
            { method: 'POST', headers: { ...headers, 'Content-Length': String(payload.length) } },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    let parsed;
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
                });
            }
        );
        request.on('error', reject);
        request.end(payload);
    });
}

async function executeFencedEffect(options) {
    const { gatewayUrl, token, identity, operationId, path, payload } = options;
    const request = options.request || postJson;
    const digest = effectDigest(path, payload);
    const expected = { operationId, identity, digest };
    const headers = buildHeaders(token, operationId, identity, digest);
    const execution = { operationId, ...identity };
    const preflight = await request(
        gatewayUrl.replace(/\/$/, '') + '/_aillium/fence/verify',
        { _ailliumExecution: execution, effect: { path, payload } },
        headers
    );
    if (preflight.statusCode !== 200) {
        throw new FencedGatewayClientError(
            preflight.body && (preflight.body.code || preflight.body.error) || 'Gateway preflight failed',
            'MESH_PREFLIGHT_FAILED',
            preflight.statusCode
        );
    }
    assertAcknowledgement(preflight.headers, expected);

    const effect = await request(
        gatewayUrl.replace(/\/$/, '') + path,
        { ...payload, _ailliumExecution: execution },
        headers
    );
    if (effect.statusCode !== 200) {
        throw new FencedGatewayClientError(
            effect.body && (effect.body.code || effect.body.error) || 'Gateway effect failed',
            'MESH_EFFECT_FAILED',
            effect.statusCode
        );
    }
    assertAcknowledgement(effect.headers, expected);
    assertProof(effect.body, expected);
    return effect.body;
}

async function cancelFencedLineage(options) {
    const { gatewayUrl, token, identity, operationId } = options;
    const request = options.request || postJson;
    const headers = buildHeaders(token, operationId, identity);
    const response = await request(
        gatewayUrl.replace(/\/$/, '') + '/_aillium/fence/cancel',
        { _ailliumExecution: { operationId, ...identity } },
        headers
    );
    if (response.statusCode !== 200) {
        throw new FencedGatewayClientError(
            response.body && (response.body.code || response.body.error) || 'Gateway cancellation failed',
            'MESH_CANCELLATION_FAILED',
            response.statusCode
        );
    }
    assertAcknowledgement(response.headers, { operationId, identity });
    if (!response.body || response.body.accepted !== true || response.body.operationId !== operationId) {
        throw new FencedGatewayClientError('Gateway cancellation acknowledgement is invalid', 'MESH_ACKNOWLEDGEMENT_MISMATCH', 502);
    }
    const proof = response.body._ailliumProof;
    if (!proof || proof.operationId !== operationId || proof.status !== 'cancelled') {
        throw new FencedGatewayClientError('Gateway cancellation proof is invalid', 'MESH_PROOF_MISMATCH', 502);
    }
    for (const [field, value] of Object.entries(identity)) {
        if (String(proof.identity && proof.identity[field]) !== String(value)) {
            throw new FencedGatewayClientError(
                'Gateway cancellation proof identity mismatch: ' + field,
                'MESH_PROOF_MISMATCH',
                502
            );
        }
    }
    return response.body;
}

module.exports = {
    FencedGatewayClientError,
    assertAcknowledgement,
    assertProof,
    buildHeaders,
    cancelFencedLineage,
    executeFencedEffect,
    postJson
};
