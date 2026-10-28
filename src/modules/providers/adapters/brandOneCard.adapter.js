'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

// Brand One Card is independent of the existing brand1-card provider.
const DEFAULT_BASE_URL = 'https://api.brand-one-card.com';
const INTERNAL_KEYS = new Set([
    'productId', 'externalProductId', 'providerProductId', 'amount', 'quantity', 'qty',
    'referenceId', 'orderUuid', 'order_uuid', 'price', 'basePrice', 'providerPrice',
    'walletBalance', 'balance', 'currency',
]);

const normaliseStatus = (status) => {
    switch (String(status ?? '').trim().toLowerCase()) {
        case 'accept': return 'Completed';
        case 'reject': return 'Cancelled';
        default: return 'Pending';
    }
};

const failure = (data, message) => ({
    success: false,
    providerOrderId: null,
    providerStatus: 'Cancelled',
    rawResponse: data,
    errorCode: data?.code ?? null,
    errorMessage: message ?? data?.msg ?? data?.detail ?? 'Brand One Card rejected the request',
});

class BrandOneCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!token) throw new Error('[BrandOneCard] api token (apiToken / apiKey) is required');
        this._client = options.httpClient || axios.create({
            baseURL: (provider.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
            timeout: options.timeoutMs ?? 180_000,
            headers: { 'api-token': token, Accept: 'application/json' },
        });
    }

    _assertSuccess(data) {
        if (String(data?.status).toUpperCase() === 'ERROR') {
            const error = new Error(`[BrandOneCard] ${data.msg ?? data.detail ?? 'Provider request failed'}`);
            error.providerCode = data.code;
            throw error;
        }
    }

    async getProducts() {
        const { data } = await this._client.get('/client/api/products');
        this._assertSuccess(data);
        if (!Array.isArray(data)) throw new Error('[BrandOneCard] Invalid product list');
        return data.map((item) => {
            if (item.id == null) throw new Error('[BrandOneCard] Product is missing its ID');
            // The platform's provider price pipeline stores USD prices.
            if (item.currency && String(item.currency).trim().toUpperCase() !== 'USD') {
                throw new Error(`[BrandOneCard] Product ${item.id} currency must be USD for the provider price pipeline`);
            }
            return this._validateDTO({
                externalProductId: String(item.id),
                rawName: item.name,
                rawPrice: item.price,
                minQty: item.qty_values == null ? 1 : Number(item.qty_values.min),
                maxQty: item.qty_values == null ? 1 : Number(item.qty_values.max),
                isActive: item.available !== false,
                rawPayload: item,
            });
        });
    }

    async getContent(categoryId = 0) {
        const { data } = await this._client.get(`/client/api/content/${encodeURIComponent(categoryId)}`);
        this._assertSuccess(data);
        return data;
    }

    _normaliseOrder(item) {
        if (item?.order_id == null) throw new Error('[BrandOneCard] Missing order ID');
        const providerStatus = normaliseStatus(item.status);
        return {
            providerOrderId: String(item.order_id),
            providerStatus,
            unifiedStatus: this.toUnifiedStatus(providerStatus),
            rawResponse: item,
        };
    }

    _checkRows(data) {
        this._assertSuccess(data);
        if (data?.status !== 'OK' || !Array.isArray(data.data)) {
            throw new Error('[BrandOneCard] Invalid check response');
        }
        return data.data;
    }

    async checkOrders(orderIds = []) {
        if (!orderIds.length) return [];
        const { data } = await this._client.get('/client/api/check', {
            params: { orders: JSON.stringify(orderIds) },
        });
        const requested = new Set(orderIds.map(String));
        return this._checkRows(data)
            .filter((item) => requested.has(String(item.order_id)))
            .map((item) => this._normaliseOrder(item));
    }

    async checkOrder(orderId) {
        const results = await this.checkOrders([orderId]);
        return results.find((item) => item.providerOrderId === String(orderId)) ?? null;
    }

    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[BrandOneCard] referenceId is required');
        const { data } = await this._client.get('/client/api/check', {
            params: { uuid: 1, orders: JSON.stringify([String(referenceId)]) },
        });
        const item = this._checkRows(data).find((row) => String(row.order_uuid) === String(referenceId));
        return item ? { found: true, ...this._normaliseOrder(item) } : { found: false };
    }

    async _recoverPlacement(referenceId) {
        try {
            const recovered = await this.checkOrderByReference(referenceId);
            if (recovered.found) {
                return { ...recovered, success: true, errorMessage: null };
            }
        } catch {
            // The fulfillment poller will retry reference lookup before manual review.
        }
        return {
            success: true,
            providerOrderId: null,
            providerStatus: 'PLACEMENT_UNCERTAIN',
            rawResponse: { placement: 'uncertain' },
            errorMessage: null,
        };
    }

    async placeOrder(params = {}) {
        const productId = params.productId ?? params.externalProductId ?? params.providerProductId;
        const qty = params.qty ?? params.quantity ?? params.amount ?? 1;
        // The fulfillment engine supplies the same orderNumber on retries and recovery.
        const orderUuid = String(params.order_uuid ?? params.orderUuid ?? params.referenceId ?? '').trim();
        if (!orderUuid) return failure(null, 'Brand One Card requires a stable referenceId / order_uuid');
        if (!/^\d+$/.test(String(productId)) || Number(productId) <= 0) {
            return failure(null, 'Brand One Card product ID must be a positive integer');
        }
        if (!Number.isSafeInteger(Number(qty)) || Number(qty) < 1) {
            return failure(null, 'Brand One Card quantity must be a positive integer');
        }
        // Product params are query keys (playerId, serverId, etc.). Products can
        // have no params, so a playerId must not be unconditionally required.
        const fields = Object.fromEntries(Object.entries(params).filter(([key, value]) => (
            !INTERNAL_KEYS.has(key) && value !== undefined && value !== null && value !== ''
        )));
        try {
            const { data } = await this._client.get(
                `/client/api/newOrder/${encodeURIComponent(productId)}/params`,
                { params: { ...fields, qty: Number(qty), order_uuid: orderUuid } }
            );
            if (data?.status === 'ERROR') {
                // The documented ERROR envelope guarantees nothing was charged.
                return failure(data);
            }
            if (data?.status !== 'OK' || data.data?.order_id == null) {
                return this._recoverPlacement(orderUuid);
            }
            const order = this._normaliseOrder(data.data);
            return {
                ...order,
                success: order.providerStatus !== 'Cancelled',
                rawResponse: data,
                errorMessage: order.providerStatus === 'Cancelled' ? 'Brand One Card rejected the order' : null,
                price: data.data.price ?? null,
            };
        } catch {
            // A lost HTTP response is not proof of rejection. Never refund it
            // before checking the unique order reference.
            return this._recoverPlacement(orderUuid);
        }
    }

    async getBalance() {
        const { data } = await this._client.get('/client/api/profile');
        this._assertSuccess(data);
        return data;
    }
}

module.exports = { BrandOneCardAdapter };
