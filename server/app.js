import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import { hashAdminPassword, verifyAdminPassword } from './adminPassword.js';
import {
    addManagedProduct,
    DEFAULT_SHOP_ID,
    getCategories,
    getFeaturedProducts,
    getAllProducts,
    getHeroProduct,
    getHeroProductForShop,
    getNewArrivals,
    getProductsForShop,
    getUploadedProductsForShop,
    removeManagedProduct,
    updateManagedStock,
    updateManagedProduct,
    findProductForShop
} from './catalog.js';
import {
    canTransitionOrderStatus,
    fingerprintOrder,
    normalizePhone,
    ORDER_STATUSES,
    OrderInputError,
    validateAndPriceOrder
} from './orders.js';
import { registerPlatformRoutes } from './platform.js';
import { isReadOnlyPreviewRequest } from './readOnlyPreview.js';
import {
    decryptTotpSecret,
    encryptTotpSecret,
    generateTotpSecret,
    totpProvisioningUri,
    verifyTotpCode
} from './adminTotp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PRODUCT_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const DEFAULT_STOREFRONT_ANNOUNCEMENT = 'Discover products from independent shops';
const IMAGE_TYPES = new Map([
    ['image/jpeg', { extension: '.jpg', format: 'jpeg' }],
    ['image/png', { extension: '.png', format: 'png' }],
    ['image/webp', { extension: '.webp', format: 'webp' }]
]);

function escapeXml(value) {
    return String(value).replace(/[<>&'"]/g, (character) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    })[character]);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function normalizeMetaDescription(value, fallback) {
    const normalized = String(value || fallback).trim().replace(/\s+/g, ' ');
    return normalized.length > 160 ? `${normalized.slice(0, 157).trimEnd()}…` : normalized;
}

function serializeJsonLd(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function isWithinDirectory(directory, filePath) {
    const relativePath = relative(directory, filePath);
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

function staticPathContainment(staticDirectory) {
    const resolvedDirectory = resolve(staticDirectory);
    return async (req, res, next) => {
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(req.path);
        } catch {
            return res.status(404).json({ error: 'Not found.' });
        }
        if (decodedPath.includes('\0')) return res.status(404).json({ error: 'Not found.' });

        const requestedPath = resolve(resolvedDirectory, `.${decodedPath}`);
        if (!isWithinDirectory(resolvedDirectory, requestedPath)) {
            return res.status(404).json({ error: 'Not found.' });
        }

        try {
            const [realDirectory, realFile] = await Promise.all([
                realpath(resolvedDirectory),
                realpath(requestedPath)
            ]);
            if (!isWithinDirectory(realDirectory, realFile)) {
                return res.status(404).json({ error: 'Not found.' });
            }
        } catch (error) {
            if (!['EACCES', 'EINVAL', 'ELOOP', 'ENAMETOOLONG', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(error?.code)) {
                return next(error);
            }
            return res.status(404).json({ error: 'Not found.' });
        }

        return next();
    };
}

class ProductInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProductInputError';
    }
}

class ProductNotFoundError extends Error {
    constructor() {
        super('Product not found.');
        this.name = 'ProductNotFoundError';
    }
}

class InventoryUnavailableError extends Error {
    constructor() {
        super('The requested stock is no longer available. Refresh the catalog and try again.');
        this.name = 'InventoryUnavailableError';
    }
}

function productUpload(uploadDirectory) {
    return multer({
        storage: multer.diskStorage({
            destination(_req, _file, callback) {
                mkdir(uploadDirectory, { recursive: true }).then(() => callback(null, uploadDirectory), callback);
            },
            filename(_req, file, callback) {
                callback(null, `${randomUUID()}${IMAGE_TYPES.get(file.mimetype).extension}`);
            }
        }),
        limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 11, fieldSize: 20_480, parts: 21 },
        fileFilter(_req, file, callback) {
            if (!IMAGE_TYPES.has(file.mimetype)) return callback(new ProductInputError('Upload a JPEG, PNG, or WebP product image.'));
            callback(null, true);
        }
    });
}

function isPublicHttpsImageUrl(value) {
    try {
        const url = new URL(value);
        const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return url.protocol === 'https:' && !url.username && !url.password
            && hostname.includes('.') && !isIP(hostname)
            && !/(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$/.test(hostname);
    } catch {
        return false;
    }
}

function validateImageUrls(value) {
    if (value == null || value === '') return [];
    if (typeof value !== 'string' || value.length > 20_480) {
        throw new ProductInputError('Enter up to 10 HTTPS image links, one per line.');
    }
    const urls = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (urls.length > 10) throw new ProductInputError('A product can have up to 10 images.');
    return urls.map((value) => {
        if (value.length > 2048) throw new ProductInputError('Product image links cannot exceed 2048 characters.');
        if (!isPublicHttpsImageUrl(value)) {
            throw new ProductInputError('Product image links must use a public HTTPS website.');
        }
        return new URL(value).href;
    });
}

function validateManagedProduct(body, images, { requireImage = true, requireCompleteDetails = true } = {}) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    const imageAlt = typeof body?.imageAlt === 'string' ? body.imageAlt.trim() : '';
    const seoTitle = typeof body?.seoTitle === 'string' ? body.seoTitle.trim() : '';
    const metaDescription = typeof body?.metaDescription === 'string' ? body.metaDescription.trim() : '';
    const imageUrls = validateImageUrls(body?.imageUrls);
    const category = typeof body?.category === 'string' ? body.category : '';
    const price = typeof body?.price === 'string' && /^\d{1,15}$/.test(body.price) ? Number(body.price) : NaN;
    const stockQuantity = typeof body?.stockQuantity === 'string' && /^\d{1,15}$/.test(body.stockQuantity)
        ? Number(body.stockQuantity)
        : NaN;
    const isAvailable = body?.isAvailable === 'true' ? true : body?.isAvailable === 'false' ? false : null;
    const oldPrice = body?.oldPrice === '' || body?.oldPrice == null
        ? null
        : typeof body.oldPrice === 'string' && /^\d{1,15}$/.test(body.oldPrice) ? Number(body.oldPrice) : NaN;
    if (name.length < 2 || name.length > 120) throw new ProductInputError('Product name must be between 2 and 120 characters.');
    if (description.length > 2000) throw new ProductInputError('Product description cannot exceed 2000 characters.');
    if (imageAlt.length > 250) throw new ProductInputError('Image alt text cannot exceed 250 characters.');
    if (seoTitle.length > 70) throw new ProductInputError('SEO title cannot exceed 70 characters.');
    if (metaDescription.length > 160) throw new ProductInputError('Meta description cannot exceed 160 characters.');
    if (requireCompleteDetails && !description) throw new ProductInputError('Enter a product description.');
    if (requireCompleteDetails && !imageAlt) throw new ProductInputError('Enter descriptive alt text for the product image.');
    if (requireCompleteDetails && !seoTitle) throw new ProductInputError('Enter an SEO title for the product.');
    if (requireCompleteDetails && !metaDescription) throw new ProductInputError('Enter a meta description for the product.');
    if (!Number.isSafeInteger(price) || price < 1) throw new ProductInputError('Enter a valid product price in whole BDT.');
    if (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0) throw new ProductInputError('Enter a valid whole-number stock quantity.');
    if (isAvailable === null) throw new ProductInputError('Choose whether this product is available for purchase.');
    if (oldPrice !== null && (!Number.isSafeInteger(oldPrice) || oldPrice <= price)) {
        throw new ProductInputError('The previous price must be a whole BDT amount greater than the current price.');
    }
    if (!PRODUCT_CATEGORY_PATTERN.test(category) && category !== 'uncategorized') {
        throw new ProductInputError('Choose a valid product category.');
    }
    if (requireImage && !images?.length && !imageUrls.length) {
        throw new ProductInputError('Upload at least one image or enter an HTTPS image link.');
    }
    if ((images?.length ?? 0) + imageUrls.length > 10) throw new ProductInputError('A product can have up to 10 images in total.');
    return {
        name,
        description,
        imageAlt: imageAlt || name,
        seoTitle: seoTitle || name,
        metaDescription: metaDescription || (description.length > 160
            ? `${description.slice(0, 157).trimEnd()}…`
            : description),
        category,
        price,
        oldPrice,
        stockQuantity,
        isAvailable,
        imageUrls
    };
}

function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function revokeAdminSessions(pool, userId, shopId = null) {
    if (typeof userId === 'string') {
        if (shopId) {
            await pool.query(
                'UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND shop_id = $2 AND revoked_at IS NULL',
                [userId, shopId]
            );
            return;
        }
        await pool.query(
            'UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
            [userId]
        );
        return;
    }
}

function isManagedProductId(id) {
    return /^admin-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function managedImagePath(uploadsDirectory, imageUrl) {
    if (typeof imageUrl !== 'string' || !/^\/uploads\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(imageUrl)) return null;
    return join(uploadsDirectory, imageUrl.slice('/uploads/'.length));
}

function imagePathsForProduct(uploadsDirectory, product) {
    return [...new Set([product.image, ...(Array.isArray(product.images) ? product.images : [])])]
        .map((image) => managedImagePath(uploadsDirectory, image))
        .filter(Boolean);
}

async function categoriesForShop(pool, shopId) {
    const { rows } = await pool.query(
        `SELECT id, name, description, icon, is_active AS active
         FROM shop_product_categories WHERE shop_id = $1`,
        [shopId]
    );
    const saved = new Map(rows.map((category) => [category.id, category]));
    const categories = new Map(getCategories(shopId).map((category) => [category.id, category]));
    for (const [id, category] of saved) {
        if (!category.active) {
            categories.delete(id);
            continue;
        }
        const previous = categories.get(id);
        categories.set(id, {
            ...previous,
            ...category,
            gradient: previous?.gradient || 'from-slate-100 to-blue-50',
            color: previous?.color || 'text-slate-700'
        });
    }
    return [...categories.values()];
}

function managedStockRequests(items) {
    const quantities = new Map();
    for (const item of items) {
        const id = String(item.productId);
        if (!id.startsWith('admin-')) continue;
        quantities.set(id, (quantities.get(id) ?? 0) + item.quantity);
    }
    return [...quantities].map(([id, quantity]) => ({ id, quantity }));
}

function normalizeInventoryAdjustment(adjustment) {
    return {
        ...adjustment,
        previousQuantity: Number(adjustment.previousQuantity),
        newQuantity: Number(adjustment.newQuantity)
    };
}

async function changeManagedStock(client, items, reserve) {
    const requested = managedStockRequests(items);
    if (!requested.length) return { reserved: false, updates: [] };
    const requestedIds = requested.map(({ id }) => id);
    const { rows: lockedRows } = await client.query(
        `SELECT id, stock_quantity AS "stockQuantity"
         FROM managed_products
         WHERE id = ANY($1::TEXT[])
         FOR UPDATE`,
        [requestedIds]
    );
    const availableStocks = new Map(lockedRows.map((row) => [row.id, Number(row.stockQuantity)]));
    if (reserve) {
        for (const { id, quantity } of requested) {
            const stockQuantity = availableStocks.get(id);
            if (stockQuantity === undefined || stockQuantity < quantity) {
                throw new InventoryUnavailableError();
            }
        }
    }
    const { rows } = await client.query(
        `WITH requested AS (
             SELECT product_id, SUM(quantity)::BIGINT AS quantity
             FROM UNNEST($1::TEXT[], $2::BIGINT[]) AS item(product_id, quantity)
             GROUP BY product_id
         ),
         adjusted AS (
             UPDATE managed_products AS product
             SET stock_quantity = CASE WHEN $3::BOOLEAN
                 THEN product.stock_quantity - requested.quantity
                 ELSE product.stock_quantity + requested.quantity
             END
             FROM requested
             WHERE product.id = requested.product_id
               AND (NOT $3::BOOLEAN OR (
                   product.is_archived = FALSE
                   AND product.is_available = TRUE
               ))
             RETURNING product.id, product.stock_quantity
         )
         SELECT
             (SELECT COUNT(*)::INTEGER FROM requested) AS "requestedCount",
             (SELECT COUNT(*)::INTEGER FROM adjusted) AS "adjustedCount",
             COALESCE(
                 (SELECT JSONB_OBJECT_AGG(id, stock_quantity::TEXT) FROM adjusted),
                 '{}'::JSONB
             ) AS "stockUpdates"`,
        [requested.map(({ id }) => id), requested.map(({ quantity }) => quantity), reserve]
    );
    const result = rows[0];
    if (reserve && Number(result.adjustedCount) !== Number(result.requestedCount)) {
        throw new InventoryUnavailableError();
    }
    return {
        reserved: reserve && requested.length > 0,
        updates: Object.entries(result.stockUpdates ?? {}).map(([id, stockQuantity]) => ({
            id,
            stockQuantity: Number(stockQuantity)
        }))
    };
}

function respondWithExistingOrder(res, saved, requestHash) {
    if (!saved) throw new Error('Could not persist the order.');
    const savedRequestHash = saved.request_hash ?? createHash('sha256').update(fingerprintOrder({
        customerName: saved.customer_name,
        phone: saved.phone,
        address: saved.address,
        bkashNumber: saved.bkash_number,
        items: saved.items,
        advanceAmount: Number(saved.advance_amount)
    })).digest('hex');
    if (savedRequestHash !== requestHash) {
        return res.status(409).json({ error: 'This checkout request was already used for different order details. Refresh and submit again.' });
    }
    return res.status(200).json({
        data: {
            orderNumber: saved.order_number,
            subtotal: Number(saved.subtotal),
            advanceAmount: Number(saved.advanceAmount),
            due: Number(saved.due)
        }
    });
}

async function validImageSignature(file) {
    const type = IMAGE_TYPES.get(file.mimetype);
    if (!type) return false;
    let sanitized;
    try {
        const image = sharp(await readFile(file.path), { failOn: 'error', limitInputPixels: 25_000_000 });
        const metadata = await image.metadata();
        if (metadata.format !== type.format || !metadata.width || !metadata.height
            || metadata.width > 10000 || metadata.height > 10000) return false;
        sanitized = await image.rotate().resize({
            width: 1600,
            height: 1600,
            fit: 'inside',
            withoutEnlargement: true
        }).toFormat(type.format, {
            ...(type.format === 'jpeg' || type.format === 'webp' ? { quality: 88 } : { compressionLevel: 9 })
        }).toBuffer();
    } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(error?.code)) throw error;
        return false;
    }
    if (!sanitized.length || sanitized.length > 5 * 1024 * 1024) return false;
    await writeFile(file.path, sanitized);
    return true;
}

function removeUploadedFile(filePath) {
    return unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
    });
}

const adminCookieName = 'shopademia_admin';

function adminCookieToken(req) {
    const cookieHeader = req.get('cookie') ?? '';
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== adminCookieName) continue;
        return part.slice(separator + 1).trim();
    }
    return '';
}

function setAdminCookie(res, token, maxAge, secure) {
    res.append('Set-Cookie', [
        `${adminCookieName}=${token}`,
        'Path=/api/v1/admin',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAge}`,
        ...(secure ? ['Secure'] : [])
    ].join('; '));
}

function clearAdminCookie(res, secure) {
    setAdminCookie(res, '', 0, secure);
}

function findProductCreationReplay(client, shopId, adminUserId, idempotencyKey) {
    return client.query(
        `SELECT request.request_fingerprint AS "requestFingerprint",
                product.id, product.name, product.description,
                product.image_alt AS "imageAlt", product.seo_title AS "seoTitle",
                product.meta_description AS "metaDescription", product.price,
                product.old_price AS "oldPrice", product.category, product.image,
                product.images, product.stock_quantity AS "stockQuantity",
                product.is_available AS "isAvailable", product.is_archived AS "isArchived",
                product.shop_id AS "shopId", product.created_at AS "createdAt"
         FROM admin_product_creation_requests request
         JOIN managed_products product ON product.id = request.product_id
         WHERE request.shop_id = $1 AND request.admin_user_id = $2
           AND request.idempotency_key = $3`,
        [shopId, adminUserId, idempotencyKey]
    );
}

function adminAuth(pool, secret, secureCookie) {
    return (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const authorization = req.get('authorization') ?? '';
        const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
        const cookieToken = adminCookieToken(req);
        const token = bearerToken || cookieToken;
        const isCookieAuth = !bearerToken && Boolean(cookieToken);
        const expireCookie = () => {
            if (isCookieAuth) clearAdminCookie(res, secureCookie);
        };
        if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
        try {
            req.admin = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'shopademia' });
        } catch {
            expireCookie();
            return res.status(401).json({ error: 'Your admin session expired. Sign in again.' });
        }
        if (req.admin.role !== 'admin' || typeof req.admin.jti !== 'string'
            || !Number.isSafeInteger(req.admin.sessionVersion)) {
            expireCookie();
            return res.status(401).json({ error: 'Your admin session expired. Sign in again.' });
        }
        const requestedShopId = req.get('x-shop-id');
        if (requestedShopId != null && !isUuid(requestedShopId)) {
            return res.status(400).json({ error: 'The selected shop ID is invalid.' });
        }
        if (typeof req.admin.userId !== 'string') {
            expireCookie();
            return res.status(401).json({ error: 'Your admin session expired. Sign in again.' });
        }
        const isPlatformToken = req.admin.isPlatformAdmin === true;
        const resolvedShopId = requestedShopId ?? req.admin.shopId ?? null;
        if (resolvedShopId !== null && !isUuid(resolvedShopId)) {
            return res.status(400).json({ error: 'The selected shop ID is invalid.' });
        }
        pool.query(
            `SELECT u.email, u.session_version AS "sessionVersion",
                    (pa.user_id IS NOT NULL) AS "isPlatformAdmin",
                    m.shop_id AS "shopId", m.role, sh.status
             FROM admin_users u
             JOIN admin_sessions s ON s.user_id = u.id
             LEFT JOIN platform_admins pa ON pa.user_id = u.id
             LEFT JOIN shop_memberships m ON m.user_id = u.id AND m.shop_id = $4
             LEFT JOIN shops sh ON sh.id = $4
             WHERE s.token_id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
               AND u.id = $2 AND u.email = $3
               AND s.shop_id IS NOT DISTINCT FROM $5
               AND ((pa.user_id IS NOT NULL AND $6::boolean)
                    OR (pa.user_id IS NULL AND m.shop_id IS NOT NULL))`,
            [req.admin.jti, req.admin.userId, req.admin.sub, resolvedShopId, req.admin.shopId ?? null, isPlatformToken]
        ).then(({ rows }) => {
            const account = rows[0];
            if (!account || req.admin.sessionVersion !== Number(account.sessionVersion)) {
                expireCookie();
                return res.status(401).json({ error: 'Your admin session expired or shop access was removed.' });
            }
            req.isPlatformAdmin = account.isPlatformAdmin;
            if (!req.isPlatformAdmin && account.status !== 'active') {
                return res.status(403).json({ error: 'This shop is suspended or archived. Contact the platform administrator.' });
            }
            if (resolvedShopId && !account.status) {
                return res.status(404).json({ error: 'Shop not found.' });
            }
            req.shopId = account.shopId ?? (req.isPlatformAdmin ? resolvedShopId : undefined);
            req.shopRole = account.role;
            return next();
        }).catch(next);
    };
}

export function createApp({ pool, config }) {
    const app = express();
    const secureAdminCookie = config.nodeEnv === 'production';
    const platformAdminMfaRequired = config.nodeEnv === 'production' || config.adminMfaRequired !== false;
    const authenticateAdmin = adminAuth(pool, config.jwtSecret, secureAdminCookie);
    const requireShopManager = (req, res, next) => {
        if (req.isPlatformAdmin || !['owner', 'admin'].includes(req.shopRole)) {
            return res.status(403).json({ error: 'Shop owner or admin permission is required.' });
        }
        return next();
    };
    const requireShopDashboard = (req, res, next) => {
        if (req.isPlatformAdmin || !req.shopId) {
            return res.status(403).json({ error: 'The platform administrator cannot access shop products or orders.' });
        }
        return next();
    };
    const uploadsDirectory = config.uploadsDir ?? join(root, 'uploads');
    const uploadProductImage = productUpload(uploadsDirectory);
    const loginLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 8,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many login attempts. Try again later.' }
    });
    const orderLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 30,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many order requests. Please try again later.' }
    });
    const orderLookupLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many order lookups. Please wait before trying again.' }
    });
    const productUploadLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many product uploads. Please try again later.' }
    });
    const publicCatalogLimit = rateLimit({
        windowMs: 60 * 1000,
        limit: 120,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many catalog requests. Please try again shortly.' }
    });
    const passwordChangeLimit = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many password changes. Try again later.' }
    });
    const canonicalHostname = config.siteUrl ? new URL(config.siteUrl).hostname.toLowerCase() : null;
    const siteOrigin = (req) => config.siteUrl || `${req.protocol}://${req.get('host')}`;
    const sendStorefrontShell = async (req, res, title, description, pageEntities = [], fallbackHtml = '') => {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        const origin = siteOrigin(req);
        const url = new URL(req.originalUrl, origin);
        const includeShop = ['/','/product/','/category/','/deals','/about','/find-order'].some((path) => path === '/' ? url.pathname === '/' : url.pathname.startsWith(path));
        const requestedShop = includeShop ? url.searchParams.get('shop') : null;
        const shop = requestedShop === 'main' ? null : requestedShop;
        const canonicalUrl = `${origin}${url.pathname}${shop ? `?shop=${encodeURIComponent(shop)}` : ''}`;
        const safeTitle = escapeHtml(title);
        const safeDescription = escapeHtml(normalizeMetaDescription(description, 'Explore products and independent shops on Shopademia.'));
        const escapedUrl = escapeHtml(canonicalUrl);
        const escapedImage = escapeHtml(`${origin}/public-assets/social-preview.png`);
        const organizationId = `${origin}/#organization`;
        const structuredData = {
            '@context': 'https://schema.org',
            '@graph': [
                {
                    '@type': 'Organization',
                    '@id': organizationId,
                    name: 'Shopademia',
                    url: `${origin}/`,
                    logo: `${origin}/public-assets/shopademia-mark.svg`
                },
                {
                    '@type': 'WebSite',
                    '@id': `${origin}/#website`,
                    name: 'Shopademia',
                    url: `${origin}/`,
                    publisher: { '@id': organizationId }
                },
                ...pageEntities
            ]
        };
        const rendered = html
            .replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
            .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${safeDescription}">`)
            .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${safeTitle}">`)
            .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${safeDescription}">`)
            .replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${escapedImage}">`)
            .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapedUrl}">`)
            .replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${safeTitle}">`)
            .replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${safeDescription}">`)
            .replace(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${escapedImage}">`)
            .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapedUrl}">`)
            .replace('</head>', `<script type="application/ld+json">${serializeJsonLd(structuredData)}</script>\n</head>`)
            .replace('<script type="module" src="/js/main.js">', `${fallbackHtml}<script type="module" src="/js/main.js">`)
            .replace(/<body([^>]*)>/, (_match, attributes) =>
                `<body${attributes}>${config.readOnlyPreview ? '<div role="status" aria-live="polite" style="padding:0.75rem 1rem;background:#173b66;color:#fff;text-align:center;font:600 0.875rem/1.4 system-ui,sans-serif">Local read-only preview: browsing is enabled; checkout, order lookup, notifications, and administration are disabled.</div>' : ''}`
            );
        return res.type('html').send(rendered);
    };

    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxyHops ?? 0);
    app.use((req, res, next) => {
        req.id = randomUUID();
        res.set('X-Request-Id', req.id);
        res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');
        next();
    });
    app.use(helmet({
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", 'https://www.googletagmanager.com', 'https://connect.facebook.net'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'https://www.facebook.com'],
                connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com', 'https://www.googletagmanager.com', 'https://www.facebook.com'],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: config.nodeEnv === 'production' ? [] : null
            }
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: false,
            preload: false
        },
        noSniff: true,
        crossOriginResourcePolicy: { policy: 'same-origin' }
    }));
    if (config.readOnlyPreview) {
        app.use((req, res, next) => {
            if (isReadOnlyPreviewRequest(req.method, req.path)) return next();
            if (!['GET', 'HEAD'].includes(req.method)) {
                res.set('Allow', 'GET, HEAD');
                return res.status(405).json({ error: 'This local preview is read-only.' });
            }
            return res.status(404).json({ error: 'Route unavailable in read-only preview mode.' });
        });
    }
    app.use((req, res, next) => {
        const requestHosts = [req.get('x-forwarded-host'), req.get('host')]
            .filter(Boolean)
            .map((host) => host.split(',')[0].trim().replace(/:\d+$/, '').toLowerCase());
        if (canonicalHostname && requestHosts.includes(`www.${canonicalHostname}`)) {
            return res.redirect(301, new URL(req.originalUrl, config.siteUrl).toString());
        }
        return next();
    });
    app.use('/api/v1/customer/order-lookup', (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    app.use(express.json({ limit: '32kb', strict: true, type: 'application/json' }));
    app.use('/api/v1/admin', (req, res, next) => {
        if (!adminCookieToken(req) || req.get('authorization')
            || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        const origin = req.get('origin');
        const expectedOrigin = config.adminSiteUrl || config.siteUrl || `${req.protocol}://${req.get('host')}`;
        if (origin !== expectedOrigin) {
            return res.status(403).json({ error: 'This admin request must come from the same origin.' });
        }
        return next();
    });

    app.get('/', async (req, res, next) => {
        try {
            const slug = typeof req.query.shop === 'string' ? req.query.shop : 'main';
            const { rows } = await pool.query('SELECT id, slug, name, status FROM shops WHERE slug = $1', [slug]);
            if (rows[0]?.status !== 'active') return res.status(404).sendFile(join(root, '404.html'));
            return await sendStorefrontShell(
                req,
                res,
                `Shop products and deals | ${rows[0].name} | Shopademia`,
                `Browse products and current offers from ${rows[0].name}. Send an order request to the shop on Shopademia.`
            );
        } catch (error) {
            return next(error);
        }
    });
    app.get(['/product/:id', '/category/:id', '/shops', '/shops/:slug', '/top-selling', '/deals', '/about', '/find-order', '/privacy', '/terms'], async (req, res, next) => {
        try {
            let title = 'Explore independent shops | Shopademia';
            let description = 'Explore products, shop profiles, and current deals on Shopademia.';
            let pageEntities = [];
            let fallbackHtml = '';
            const productRoute = req.path.startsWith('/product/');
            const categoryRoute = req.path.startsWith('/category/');
            const shopProfileRoute = /^\/shops\/[^/]+$/.test(req.path);
            const selectedShopRoute = ['/deals', '/about', '/find-order'].includes(req.path);
            let selectedShop = null;
            if (productRoute || categoryRoute || shopProfileRoute || selectedShopRoute) {
                const shopSlug = shopProfileRoute
                    ? req.params.slug
                    : (typeof req.query.shop === 'string' ? req.query.shop : 'main');
                const { rows } = await pool.query(
                    'SELECT id, slug, name, status FROM shops WHERE slug = $1',
                    [shopSlug]
                );
                selectedShop = rows[0];
                if (selectedShop?.status !== 'active') return res.status(404).sendFile(join(root, '404.html'));
            }
            if (req.path.startsWith('/product/')) {
                const product = findProductForShop(req.params.id, selectedShop.id);
                if (!product) return res.status(404).sendFile(join(root, '404.html'));
                const seoTitle = product.seoTitle?.trim() || product.name;
                title = `${seoTitle} | ${selectedShop.name} | Shopademia`;
                description = product.metaDescription?.trim()
                    || product.description
                    || `${product.name} from ${selectedShop.name}. View price and availability on Shopademia.`;
                const image = typeof product.image === 'string'
                    && (/^\/uploads\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(product.image)
                        || isPublicHttpsImageUrl(product.image))
                    ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.imageAlt || product.name)}">`
                    : '';
                const available = product.isAvailable !== false
                    && !(Number.isSafeInteger(product.stockQuantity) && product.stockQuantity <= 0);
                fallbackHtml = `<noscript><main><article><h1>${escapeHtml(product.name)}</h1>${image}<p>${escapeHtml(product.description || `Product details for ${product.name}.`)}</p><p>Sold by ${escapeHtml(selectedShop.name)}</p><p>Price: BDT ${Number(product.price).toLocaleString('en-US')}</p><p>${available ? 'Available to order' : 'Currently unavailable'}</p></article></main></noscript>\n`;
                const origin = siteOrigin(req);
                const productUrl = `${origin}${req.path}${selectedShop.slug === 'main' ? '' : `?shop=${encodeURIComponent(selectedShop.slug)}`}`;
                const productSchema = {
                    '@type': 'Product',
                    name: product.name,
                    sku: String(product.id),
                    url: productUrl,
                    ...(product.metaDescription || product.description
                        ? { description: product.metaDescription || product.description }
                        : {}),
                    ...(typeof product.image === 'string'
                        && (/^\/uploads\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(product.image)
                            || isPublicHttpsImageUrl(product.image))
                        ? { image: new URL(product.image, origin).href }
                        : {}),
                    offers: {
                        '@type': 'Offer',
                        url: productUrl,
                        priceCurrency: 'BDT',
                        price: String(product.price),
                        availability: product.isAvailable === false || (Number.isSafeInteger(product.stockQuantity) && product.stockQuantity <= 0)
                            ? 'https://schema.org/OutOfStock'
                            : 'https://schema.org/InStock'
                    }
                };
                const category = (await categoriesForShop(pool, selectedShop.id)).find(({ id }) => id === product.category);
                const categoryName = category?.name || 'Category';
                const homeUrl = `${origin}/${selectedShop.slug === 'main' ? '' : `?shop=${encodeURIComponent(selectedShop.slug)}`}`;
                const categoryUrl = `${origin}/category/${encodeURIComponent(product.category)}${selectedShop.slug === 'main' ? '' : `?shop=${encodeURIComponent(selectedShop.slug)}`}`;
                pageEntities = [
                    productSchema,
                    {
                        '@type': 'BreadcrumbList',
                        itemListElement: [
                            { '@type': 'ListItem', position: 1, name: selectedShop.name, item: homeUrl },
                            { '@type': 'ListItem', position: 2, name: categoryName, item: categoryUrl },
                            { '@type': 'ListItem', position: 3, name: product.name, item: productUrl }
                        ]
                    }
                ];
            } else if (req.path.startsWith('/category/')) {
                const category = (await categoriesForShop(pool, selectedShop.id)).find(({ id }) => id === req.params.id);
                if (!category) return res.status(404).sendFile(join(root, '404.html'));
                title = `${category.name} | ${selectedShop.name} | Shopademia`;
                description = `Browse ${category.name} products from ${selectedShop.name} on Shopademia.`;
                fallbackHtml = `<noscript><main><h1>${escapeHtml(category.name)}</h1><p>Browse ${escapeHtml(category.name.toLowerCase())} products from ${escapeHtml(selectedShop.name)} on Shopademia.</p></main></noscript>\n`;
            } else if (req.path === '/shops') {
                title = 'Explore our shops | Shopademia';
                description = 'Explore shop profiles, products, storefronts, and current deals on Shopademia.';
            } else if (req.path === '/top-selling') {
                title = 'Top selling this week | Shopademia';
                description = 'Browse popular products from independent shops, ranked by this week’s non-cancelled order requests.';
            } else if (shopProfileRoute) {
                title = `${selectedShop.name} | Shopademia`;
                description = `Visit ${selectedShop.name} on Shopademia to browse its shop profile, products, and current offers.`;
                pageEntities.push({
                    '@type': 'OnlineStore',
                    '@id': `${siteOrigin(req)}${req.path}#store`,
                    name: selectedShop.name,
                    url: `${siteOrigin(req)}${req.path}`,
                    parentOrganization: { '@id': `${siteOrigin(req)}/#organization` }
                });
                fallbackHtml = `<noscript><main><h1>${escapeHtml(selectedShop.name)}</h1><p>Visit ${escapeHtml(selectedShop.name)} on Shopademia to browse its products and current offers.</p></main></noscript>\n`;
            } else if (req.path === '/deals') {
                title = 'Deals and offers | Shopademia';
                description = 'Browse discounted products from active independent shops across the Shopademia marketplace.';
            } else if (req.path === '/about') {
                title = `About ${selectedShop.name} | Shopademia`;
                description = 'Learn how Shopademia connects customers with independent shops and order requests.';
            } else if (req.path === '/find-order') {
                title = `Find your order | ${selectedShop.name} | Shopademia`;
                description = 'Look up your Shopademia order request using your order number and checkout phone number.';
            } else if (req.path === '/privacy') {
                title = 'Privacy policy | Shopademia';
                description = 'Learn what information Shopademia processes and how browser storage and optional analytics work.';
            } else if (req.path === '/terms') {
                title = 'Terms & conditions | Shopademia';
                description = 'Review the terms for browsing Shopademia and submitting order requests to independent shops.';
            }
            return await sendStorefrontShell(req, res, title, description, pageEntities, fallbackHtml);
        } catch (error) {
            return next(error);
        }
    });
    app.get('/admin', async (_req, res, next) => {
        try {
            const html = await readFile(join(root, 'admin.html'), 'utf8');
            return res.set('Cache-Control', 'no-store')
                .type('html')
                .send(html.replace('content="__PLATFORM_ADMIN_MFA_REQUIRED__"',
                    `content="${platformAdminMfaRequired}"`));
        } catch (error) {
            return next(error);
        }
    });
    app.get('/admin/platform', (_req, res) => res.sendFile(join(root, 'admin-platform.html')));
    app.get('/service-worker.js', (_req, res) => {
        res.set('Cache-Control', 'no-cache');
        return res.sendFile(join(root, 'service-worker.js'));
    });
    app.get('/robots.txt', (req, res) => {
        const origin = siteOrigin(req);
        return res.type('text/plain').send(
            `User-agent: *\nAllow: /\nAllow: /api/v1/products\nAllow: /api/v1/categories\nAllow: /api/v1/shops\nAllow: /api/v1/shops/\nDisallow: /admin\nDisallow: /api/v1/admin/\nDisallow: /api/v1/customer/\nDisallow: /api/v1/shops/*/push-subscriptions\nSitemap: ${origin}/sitemap.xml\n`
        );
    });
    app.get('/sitemap.xml', async (req, res, next) => {
        try {
            const origin = siteOrigin(req);
            const { rows } = await pool.query("SELECT id, slug FROM shops WHERE status = 'active'");
            const slugByShopId = new Map(rows.map(({ id, slug }) => [id, slug]));
            const shopSlugs = rows.map(({ slug }) => slug);
            const urls = new Set([
                '/',
                '/shops',
                ...(config.readOnlyPreview ? [] : ['/top-selling']),
                '/deals',
                '/about',
                '/find-order',
                '/privacy',
                '/terms'
            ]);
            for (const slug of shopSlugs) {
                urls.add(`/shops/${encodeURIComponent(slug)}`);
                if (slug !== 'main') urls.add(`/?shop=${encodeURIComponent(slug)}`);
            }
            for (const product of getAllProducts()) {
                const shopSlug = slugByShopId.get(product.shopId);
                if (!shopSlug) continue;
                const shopQuery = shopSlug === 'main' ? '' : `?shop=${encodeURIComponent(shopSlug)}`;
                urls.add(`/product/${encodeURIComponent(product.id)}${shopQuery}`);
                urls.add(`/category/${encodeURIComponent(product.category)}${shopQuery}`);
            }
            const xml = [...urls].map((path) => `  <url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`).join('\n');
            return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xml}\n</urlset>\n`);
        } catch (error) {
            return next(error);
        }
    });
    app.get('/404', (_req, res) => res.status(404).sendFile(join(root, '404.html')));
    app.get('/admin/', (_req, res) => res.redirect(308, '/admin'));
    const staticRoots = [
        ['/css', join(root, 'css'), { index: false, fallthrough: false, maxAge: 0 }],
        ['/js', join(root, 'js'), { index: false, fallthrough: false, maxAge: 0 }],
        ['/admin-assets', join(root, 'admin-assets'), { index: false, fallthrough: false, maxAge: 0 }],
        ['/public-assets', join(root, 'public-assets'), { index: false, fallthrough: false, maxAge: '1d' }],
        ['/uploads', uploadsDirectory, {
        index: false,
        fallthrough: false,
        immutable: true,
        maxAge: '1y'
        }]
    ];
    for (const [mountPath, directory, options] of staticRoots) {
        app.use(mountPath, staticPathContainment(directory));
        app.use(mountPath, express.static(directory, options));
    }
    app.use((error, req, res, next) => {
        const status = error?.status ?? error?.statusCode;
        if (config.readOnlyPreview
            && /^\/(?:css|js|public-assets|uploads)\//.test(req.path)
            && [400, 403, 404].includes(status)) {
            return res.status(404).json({ error: 'Not found.' });
        }
        return next(error);
    });

    app.get('/api/v1/products', publicCatalogLimit, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT id, slug, name, advance_charge AS "shopAdvanceCharge"
                 FROM shops WHERE status = 'active'`
            );
            const activeShops = new Map(rows.map((shop) => [shop.id, shop]));
            const allProducts = [...getFeaturedProducts(), ...getNewArrivals()]
                .map((product) => {
                    const shop = activeShops.get(product.shopId ?? DEFAULT_SHOP_ID);
                    return shop ? {
                        ...product,
                        shopId: shop.id,
                        shopSlug: shop.slug,
                        shopName: shop.name,
                        shopAdvanceCharge: Number(shop.shopAdvanceCharge)
                    } : null;
                })
                .filter(Boolean);
            if (req.query.featured === 'true') {
                return res.json({ data: allProducts.slice(0, Math.ceil(allProducts.length / 2)) });
            }
            if (req.query.sort === 'newest') {
                const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 50);
                return res.json({ data: allProducts.slice(-limit).reverse() });
            }
            return res.json({ data: allProducts });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops/:slug/products', publicCatalogLimit, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT id, slug, name, advance_charge AS "shopAdvanceCharge"
                 FROM shops WHERE slug = $1 AND status = 'active'`,
                [req.params.slug]
            );
            const shop = rows[0];
            if (!shop) return res.status(404).json({ error: 'Shop not found.' });
            const data = getProductsForShop(shop.id).map((product) => ({
                ...product,
                shopId: shop.id,
                shopSlug: shop.slug,
                shopName: shop.name,
                shopAdvanceCharge: Number(shop.shopAdvanceCharge)
            }));
            if (req.query.featured === 'true') {
                return res.json({ data: data.slice(0, Math.ceil(data.length / 2)), shop: { id: shop.id, slug: shop.slug, name: shop.name } });
            }
            if (req.query.sort === 'newest') {
                const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 50);
                return res.json({ data: data.slice(-limit).reverse(), shop: { id: shop.id, slug: shop.slug, name: shop.name } });
            }
            return res.json({ data, shop: { id: shop.id, slug: shop.slug, name: shop.name } });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/discounted-products', publicCatalogLimit, async (_req, res, next) => {
        res.set('Cache-Control', 'public, max-age=60');
        try {
            const { rows: shops } = await pool.query(
                `SELECT id, slug, name, advance_charge AS "shopAdvanceCharge" FROM shops
                 WHERE status = 'active' ORDER BY name, slug`
            );
            const data = shops.flatMap((shop) => getProductsForShop(shop.id)
                .filter((product) => product.oldPrice != null && product.oldPrice > product.price)
                .map((product) => ({
                    ...product,
                    shopId: shop.id,
                    shopSlug: shop.slug,
                    shopName: shop.name,
                    shopAdvanceCharge: Number(shop.shopAdvanceCharge)
                })));
            return res.json({ data });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/top-selling', publicCatalogLimit, async (_req, res, next) => {
        res.set('Cache-Control', 'public, max-age=60');
        try {
            const { rows } = await pool.query(
                `SELECT s.id AS "shopId", s.slug AS "shopSlug", s.name AS "shopName",
                        s.advance_charge AS "shopAdvanceCharge",
                        item->>'productId' AS "productId",
                        SUM((item->>'quantity')::integer)::int AS units
                 FROM orders o
                 JOIN shops s ON s.id = o.shop_id AND s.status = 'active'
                 CROSS JOIN LATERAL jsonb_array_elements(o.items) AS item
                 WHERE o.status <> 'cancelled'
                   AND o.created_at >= date_trunc('week', NOW())
                 GROUP BY s.id, s.slug, s.name, s.advance_charge, item->>'productId'
                 ORDER BY SUM((item->>'quantity')::integer) DESC, s.name, item->>'productId'
                 LIMIT 50`
            );
            const data = [];
            for (const row of rows) {
                const product = findProductForShop(row.productId, row.shopId);
                if (!product || product.isAvailable === false || product.stockQuantity === 0) continue;
                const { shopId: productShopId, ...publicProduct } = product;
                data.push({
                    ...publicProduct,
                    shopId: row.shopId || productShopId,
                    shopSlug: row.shopSlug,
                    shopName: row.shopName,
                    shopAdvanceCharge: Number(row.shopAdvanceCharge)
                });
                if (data.length === 10) break;
            }
            return res.json({ data });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/public/shops/:slug/products', publicCatalogLimit, async (req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        res.set('Cache-Control', 'public, max-age=30');
        try {
            const limitValue = req.query.limit === undefined ? '50' : req.query.limit;
            const offsetValue = req.query.offset === undefined ? '0' : req.query.offset;
            if (typeof limitValue !== 'string' || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100) {
                return res.status(400).json({ error: 'Limit must be a whole number from 1 to 100.' });
            }
            if (typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue)) {
                return res.status(400).json({ error: 'Offset must be a non-negative whole number.' });
            }
            const category = req.query.category;
            if (category !== undefined && (typeof category !== 'string' || !PRODUCT_CATEGORY_PATTERN.test(category))) {
                return res.status(400).json({ error: 'Choose a valid product category.' });
            }
            const { rows } = await pool.query(
                `SELECT id, slug, name FROM shops WHERE slug = $1 AND status = 'active'`,
                [req.params.slug]
            );
            const shop = rows[0];
            if (!shop) return res.status(404).json({ error: 'Shop not found.' });
            if (category !== undefined && !(await categoriesForShop(pool, shop.id)).some((item) => item.id === category)) {
                return res.status(400).json({ error: 'Choose a valid product category.' });
            }
            const offset = Number(offsetValue);
            const limit = Number(limitValue);
            const products = getUploadedProductsForShop(shop.id)
                .filter((product) => category === undefined || product.category === category);
            const data = products.slice(offset, offset + limit).map((product) => ({
                id: product.id,
                name: product.name,
                description: product.description,
                imageAlt: product.imageAlt || product.name,
                seoTitle: product.seoTitle || product.name,
                metaDescription: product.metaDescription || (product.description.length > 160
                    ? `${product.description.slice(0, 157).trimEnd()}…`
                    : product.description),
                price: product.price,
                oldPrice: product.oldPrice,
                image: product.image ? new URL(product.image, siteOrigin(req)).href : null,
                images: product.images.map((image) => new URL(image, siteOrigin(req)).href),
                category: product.category,
                stockQuantity: product.stockQuantity,
                isAvailable: product.isAvailable,
                isAvailableForPurchase: product.isAvailable && product.stockQuantity > 0
            }));
            return res.json({
                shop: { slug: shop.slug, name: shop.name },
                data,
                pagination: { total: products.length, limit, offset, hasMore: offset + data.length < products.length }
            });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops/:slug/categories', publicCatalogLimit, async (req, res, next) => {
        try {
            const shop = await pool.query("SELECT id FROM shops WHERE slug = $1 AND status = 'active'", [req.params.slug]);
            if (!shop.rows[0]) return res.status(404).json({ error: 'Shop not found.' });
            return res.json({ data: await categoriesForShop(pool, shop.rows[0].id) });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops/:slug/products/hero-offer', publicCatalogLimit, async (req, res, next) => {
        try {
            const shop = await pool.query("SELECT id FROM shops WHERE slug = $1 AND status = 'active'", [req.params.slug]);
            if (!shop.rows[0]) return res.status(404).json({ error: 'Shop not found.' });
            return res.json({ data: getHeroProductForShop(shop.rows[0].id) });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops/:slug', publicCatalogLimit, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT id, slug, name, description, location,
                        contact_email AS "contactEmail", contact_phone AS "contactPhone",
                        contact_whatsapp AS "contactWhatsApp", logo_image AS "logoImage",
                        hero_image AS "heroImage", banner_image AS "bannerImage",
                        advance_charge AS "advanceCharge"
                 FROM shops s WHERE slug = $1 AND status = 'active'`,
                [req.params.slug]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Shop not found.' });
            return res.json({ data: rows[0] });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops', publicCatalogLimit, async (_req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT slug, name, description, location, logo_image AS "logoImage",
                        hero_image AS "heroImage", banner_image AS "bannerImage"
                 FROM shops WHERE status = 'active' ORDER BY name, slug`
            );
            return res.json({ data: rows });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/categories', publicCatalogLimit, (_req, res) => res.json({ data: getCategories() }));
    app.get('/api/v1/admin/shop/categories', authenticateAdmin, requireShopManager, async (req, res, next) => {
        try {
            const data = await categoriesForShop(pool, req.shopId);
            const { rows } = await pool.query(
                `SELECT category AS id, COUNT(*)::int AS "productCount"
                 FROM managed_products WHERE shop_id = $1 GROUP BY category`,
                [req.shopId]
            );
            const counts = new Map(rows.map((row) => [row.id, row.productCount]));
            return res.json({ data: data.map((category) => ({ ...category, productCount: counts.get(category.id) || 0 })) });
        } catch (error) {
            return next(error);
        }
    });
    app.post('/api/v1/admin/shop/categories', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
        const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
        if (name.length < 2 || name.length > 60) {
            return res.status(400).json({ error: 'Category name must be between 2 and 60 characters.' });
        }
        if (description.length > 240) return res.status(400).json({ error: 'Category description cannot exceed 240 characters.' });
        const generatedId = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
        const id = typeof req.body?.slug === 'string' && req.body.slug.trim()
            ? req.body.slug.trim().toLowerCase()
            : generatedId;
        if (!PRODUCT_CATEGORY_PATTERN.test(id)) {
            return res.status(400).json({ error: 'Use a category slug with 2 to 48 lowercase letters, numbers, or hyphens.' });
        }
        try {
            const { rows } = await pool.query(
                `WITH created AS (
                     INSERT INTO shop_product_categories (shop_id, id, name, description, icon)
                     VALUES ($1, $2, $3, $4, 'fa-box')
                     ON CONFLICT (shop_id, id) DO UPDATE
                         SET name = EXCLUDED.name, description = EXCLUDED.description, is_active = TRUE
                     RETURNING id, name, description, icon, is_active AS active, is_default AS "isDefault"
                 ), logged AS (
                     INSERT INTO shop_activity_logs (shop_id, actor_email, action, entity_type, entity_id, details)
                     SELECT $1, $5, 'category.created', 'category', id, jsonb_build_object('name', name)
                     FROM created RETURNING id
                 )
                 SELECT created.* FROM created CROSS JOIN logged`,
                [req.shopId, id, name, description, req.admin.sub]
            );
            return res.status(201).json({ data: rows[0] });
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' });
            return next(error);
        }
    });
    app.patch('/api/v1/admin/shop/categories/:id', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const id = req.params.id;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
        const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim().toLowerCase() : id;
        const description = typeof req.body?.description === 'string' ? req.body.description.trim() : null;
        if (!PRODUCT_CATEGORY_PATTERN.test(id) || !PRODUCT_CATEGORY_PATTERN.test(slug)
            || name.length < 2 || name.length > 60 || (description !== null && description.length > 240)) {
            return res.status(400).json({ error: 'Choose a category and enter a name between 2 and 60 characters.' });
        }
        const client = await pool.connect();
        let transactionOpen = false;
        try {
            await client.query('BEGIN');
            transactionOpen = true;
            const { rows } = await client.query(
                `UPDATE shop_product_categories
                 SET id = $1, name = $2, description = COALESCE($3, description)
                 WHERE shop_id = $4 AND id = $5 AND is_active = TRUE
                 RETURNING id, name, description, icon, is_active AS active, is_default AS "isDefault"`,
                [slug, name, description, req.shopId, id]
            );
            if (!rows[0]) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ error: 'Category not found.' });
            }
            if (slug !== id) {
                await client.query(
                    'UPDATE managed_products SET category = $1 WHERE shop_id = $2 AND category = $3',
                    [slug, req.shopId, id]
                );
            }
            await client.query(
                `INSERT INTO shop_activity_logs (shop_id, actor_email, action, entity_type, entity_id, details)
                 VALUES ($1, $2, 'category.updated', 'category', $3, $4::jsonb)`,
                [req.shopId, req.admin.sub, slug, JSON.stringify({ previousSlug: id, name, description })]
            );
            await client.query('COMMIT');
            transactionOpen = false;
            return res.json({ data: rows[0] });
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Could not roll back category update:', rollbackError.message);
            });
            if (error.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' });
            return next(error);
        } finally {
            client.release();
        }
    });
    app.delete('/api/v1/admin/shop/categories/:id', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const id = req.params.id;
        const deleteProducts = req.body?.deleteProducts;
        if (!PRODUCT_CATEGORY_PATTERN.test(id) || typeof deleteProducts !== 'boolean') {
            return res.status(400).json({ error: 'Choose whether to keep or delete products in this category.' });
        }
        if (deleteProducts) {
            return res.status(400).json({ error: 'Category removal cannot delete products. Reassign them to uncategorized instead.' });
        }
        const client = await pool.connect();
        let transactionOpen = false;
        try {
            await client.query('BEGIN');
            transactionOpen = true;
            const { rows: categoryRows } = await client.query(
                `SELECT id, is_default AS "isDefault" FROM shop_product_categories
                 WHERE shop_id = $1 AND id = $2 AND is_active = TRUE FOR UPDATE`,
                [req.shopId, id]
            );
            const category = categoryRows[0];
            if (!category) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ error: 'Category not found.' });
            }
            let removedProducts = [];
            if (deleteProducts) {
                const { rows } = await client.query(
                    `DELETE FROM managed_products WHERE shop_id = $1 AND category = $2
                     RETURNING id, image, images`,
                    [req.shopId, id]
                );
                removedProducts = rows;
            } else {
                await client.query(
                    `UPDATE managed_products SET category = 'uncategorized'
                     WHERE shop_id = $1 AND category = $2`,
                    [req.shopId, id]
                );
            }
            if (category.isDefault) {
                await client.query(
                    `UPDATE shop_product_categories SET is_active = FALSE
                     WHERE shop_id = $1 AND id = $2`,
                    [req.shopId, id]
                );
            } else {
                await client.query(
                    `DELETE FROM shop_product_categories WHERE shop_id = $1 AND id = $2`,
                    [req.shopId, id]
                );
            }
            await client.query(
                `INSERT INTO shop_activity_logs (shop_id, actor_email, action, entity_type, entity_id, details)
                 VALUES ($1, $2, 'category.deleted', 'category', $3, $4::jsonb)`,
                [req.shopId, req.admin.sub, id, JSON.stringify({ deleteProducts, productCount: removedProducts.length })]
            );
            await client.query('COMMIT');
            transactionOpen = false;
            for (const product of removedProducts) removeManagedProduct(product.id);
            if (deleteProducts) {
                const paths = removedProducts.flatMap((product) => imagePathsForProduct(uploadsDirectory, product));
                await Promise.all(paths.map((path) => removeUploadedFile(path).catch((error) => {
                    if (error.code !== 'ENOENT') console.error('Could not remove deleted category product image:', error.message);
                })));
            } else {
                for (const product of getUploadedProductsForShop(req.shopId).filter((item) => item.category === id)) {
                    updateManagedProduct({ ...product, category: 'uncategorized' });
                }
            }
            return res.json({ data: { id, deletedProducts: removedProducts.length } });
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK');
            return next(error);
        } finally {
            client.release();
        }
    });
    app.get('/api/v1/storefront-config', publicCatalogLimit, async (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try {
            const { rows } = await pool.query(
                `SELECT id AS "shopId", advance_charge AS "advanceCharge"
                 FROM shops WHERE slug = 'main' AND status = 'active'`
            );
            if (!rows[0]) return res.status(404).json({ error: 'Shop not found or unavailable.' });
            return res.json({ shop: rows[0], delivery: { advanceCharge: Number(rows[0].advanceCharge) } });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/storefront-announcement', publicCatalogLimit, async (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (config.readOnlyPreview) {
            return res.json({ data: { text: DEFAULT_STOREFRONT_ANNOUNCEMENT } });
        }
        try {
            const { rows } = await pool.query(
                `SELECT value, is_secret AS "isSecret"
                 FROM admin_settings
                 WHERE setting_group = 'storefront' AND setting_key = 'announcement'`
            );
            if (!rows[0]) return res.json({ data: { text: DEFAULT_STOREFRONT_ANNOUNCEMENT } });
            const text = rows[0].value;
            if (rows[0].isSecret || typeof text !== 'string' || !text.trim() || text.length > 160) {
                return res.status(503).json({ error: 'The storefront announcement is not configured correctly.' });
            }
            return res.json({ data: { text } });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/shops/:slug/config', publicCatalogLimit, async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try {
            const { rows } = await pool.query(
                `SELECT id AS "shopId", slug, name, description, location,
                        contact_email AS "contactEmail", contact_phone AS "contactPhone",
                        contact_whatsapp AS "contactWhatsApp", logo_image AS "logoImage",
                        hero_image AS "heroImage",
                        banner_image AS "bannerImage", advance_charge AS "advanceCharge"
                 FROM shops WHERE slug = $1 AND status = 'active'`,
                [req.params.slug]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Shop not found.' });
            const { rows: heroSlides } = await pool.query(
                `SELECT id, position, image, mobile_image AS "mobileImage", headline, body_text AS "bodyText",
                        button_text AS "buttonText", target_url AS "targetUrl"
                 FROM shop_hero_slides WHERE shop_id = $1 ORDER BY position`,
                [rows[0].shopId]
            );
            return res.json({
                data: { ...rows[0], heroSlides },
                delivery: { advanceCharge: Number(rows[0].advanceCharge) }
            });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/products/hero-offer', publicCatalogLimit, (_req, res) => res.json({ data: getHeroProduct() }));
    app.get('/api/v1/admin/dashboard', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        try {
            const [orders, products] = await Promise.all([
                pool.query(
                    `SELECT COUNT(*)::int AS total,
                            COALESCE(jsonb_object_agg(status, count), '{}'::jsonb) AS "byStatus"
                     FROM (
                         SELECT status, COUNT(*)::int AS count
                         FROM orders WHERE shop_id = $1
                         GROUP BY status
                     ) counts`,
                    [req.shopId]
                ),
                pool.query(
                    `SELECT COUNT(*)::int AS total,
                            COUNT(*) FILTER (WHERE is_available)::int AS available,
                            COUNT(*) FILTER (WHERE stock_quantity = 0)::int AS "outOfStock",
                            COALESCE(SUM(stock_quantity), 0)::bigint AS "stockUnits"
                     FROM managed_products WHERE shop_id = $1 AND is_archived = FALSE`,
                    [req.shopId]
                )
            ]);
            return res.json({
                data: {
                    orders: orders.rows[0],
                    products: products.rows[0],
                    generatedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/admin/products', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        const paginated = req.query.limit !== undefined || req.query.offset !== undefined;
        const limitValue = req.query.limit === undefined ? '50' : req.query.limit;
        const offsetValue = req.query.offset === undefined ? '0' : req.query.offset;
        if (paginated && (typeof limitValue !== 'string'
            || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100)) {
            return res.status(400).json({ error: 'Product limit must be an integer from 1 to 100.' });
        }
        if (paginated && (typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue))) {
            return res.status(400).json({ error: 'Product offset must be a non-negative integer.' });
        }
        const limit = Number(limitValue);
        const offset = Number(offsetValue);
        try {
            const productsQuery = pool.query(
                `SELECT id, name, description, image_alt AS "imageAlt",
                        seo_title AS "seoTitle", meta_description AS "metaDescription",
                        price, old_price AS "oldPrice",
                        category, image, images, stock_quantity AS "stockQuantity",
                        is_available AS "isAvailable", is_archived AS "isArchived", shop_id AS "shopId",
                        created_at AS "createdAt"
                 FROM managed_products
                 WHERE shop_id = $1
                 ORDER BY created_at DESC, id DESC${paginated ? '\n                 LIMIT $2 OFFSET $3' : ''}`,
                paginated ? [req.shopId, limit, offset] : [req.shopId]
            );
            const [products, counts] = await Promise.all([
                productsQuery,
                paginated
                    ? pool.query('SELECT COUNT(*)::int AS total FROM managed_products WHERE shop_id = $1', [req.shopId])
                    : Promise.resolve(null)
            ]);
            return res.json({
                data: products.rows,
                ...(counts ? { pagination: {
                    limit,
                    offset,
                    total: counts.rows[0].total,
                    hasMore: offset + products.rows.length < counts.rows[0].total
                } } : {})
            });
        } catch (error) {
            return next(error);
        }
    });
    app.get('/api/v1/admin/products/:id', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        const id = req.params.id;
        if (!isManagedProductId(id)) return res.status(404).json({ error: 'Product not found.' });
        try {
            const { rows } = await pool.query(
                `SELECT id, name, description, image_alt AS "imageAlt",
                        seo_title AS "seoTitle", meta_description AS "metaDescription",
                        price, old_price AS "oldPrice",
                        category, image, images, stock_quantity AS "stockQuantity",
                        is_available AS "isAvailable", is_archived AS "isArchived", shop_id AS "shopId",
                        created_at AS "createdAt"
                 FROM managed_products WHERE id = $1 AND shop_id = $2`,
                [id, req.shopId]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });
            return res.json({ data: rows[0] });
        } catch (error) {
            return next(error);
        }
    });
    const productImagesUpload = uploadProductImage.fields([
        { name: 'image', maxCount: 1 },
        { name: 'images', maxCount: 10 }
    ]);
    app.post('/api/v1/admin/products', authenticateAdmin, requireShopManager, productUploadLimit, productImagesUpload, async (req, res, next) => {
        const imageFiles = [...(req.files?.images ?? []), ...(req.files?.image ?? [])];
        const idempotencyKey = req.get('Idempotency-Key');
        if (!isUuid(idempotencyKey)) {
            for (const imageFile of imageFiles) await removeUploadedFile(imageFile.path).catch((error) => {
                console.error('Could not remove product image after invalid create key:', error.message);
            });
            return res.status(400).json({ error: 'A valid UUID Idempotency-Key header is required for product creation.' });
        }
        let client;
        let transactionOpen = false;
        let imagesPersisted = false;
        let commitAttempted = false;
        let commitOutcomeUnknown = false;
        let lockScope;
        let requestFingerprint;
        try {
            const product = validateManagedProduct(req.body, imageFiles);
            if (product.category !== 'uncategorized') {
                const category = await pool.query(
                    'SELECT id FROM shop_product_categories WHERE shop_id = $1 AND id = $2 AND is_active = TRUE',
                    [req.shopId, product.category]
                );
                if (!category.rows[0]) throw new ProductInputError('Choose a valid product category.');
            }
            for (const imageFile of imageFiles) {
                if (!await validImageSignature(imageFile)) {
                    throw new ProductInputError('The uploaded file does not match its JPEG, PNG, or WebP image type.');
                }
            }
            const imageHashes = await Promise.all(imageFiles.map(async (imageFile) =>
                createHash('sha256').update(await readFile(imageFile.path)).digest('hex')
            ));
            requestFingerprint = createHash('sha256')
                .update(JSON.stringify({ product, imageHashes }))
                .digest('hex');
            client = await pool.connect();
            await client.query('BEGIN');
            transactionOpen = true;
            lockScope = `${req.shopId}:${req.admin.userId}:product-create:${idempotencyKey}`;
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockScope]);
            const previous = await findProductCreationReplay(
                client, req.shopId, req.admin.userId, idempotencyKey
            );
            if (previous.rows[0]) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                for (const imageFile of imageFiles) await removeUploadedFile(imageFile.path).catch((error) => {
                    console.error('Could not remove duplicate product image upload:', error.message);
                });
                if (previous.rows[0].requestFingerprint !== requestFingerprint) {
                    return res.status(409).json({ error: 'This product creation key was already used for a different request.' });
                }
                return res.status(201).json({ data: updateManagedProduct(previous.rows[0]), replayed: true });
            }
            const record = {
                id: `admin-${randomUUID()}`,
                shopId: req.shopId,
                ...product,
                image: imageFiles.length ? `/uploads/${imageFiles[0].filename}` : product.imageUrls[0],
                images: [...imageFiles.map((file) => `/uploads/${file.filename}`), ...product.imageUrls]
            };
            const { rows } = await client.query(
                `WITH saved AS (
                    INSERT INTO managed_products
                    (id, name, description, image_alt, seo_title, meta_description,
                     price, old_price, category, image, stock_quantity, is_available, shop_id, images)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    RETURNING *
                 ), request AS (
                    INSERT INTO admin_product_creation_requests
                        (shop_id, admin_user_id, idempotency_key, request_fingerprint, product_id)
                    SELECT $13, $16, $17, $18, id FROM saved
                    RETURNING product_id
                 ), logged AS (
                    INSERT INTO shop_activity_logs (shop_id, actor_email, action, entity_type, entity_id, details)
                    SELECT shop_id, $15, 'product.created', 'product', id,
                           jsonb_build_object('name', name)
                    FROM saved
                    RETURNING id
                 )
                 SELECT saved.id, saved.name, saved.description,
                        saved.image_alt AS "imageAlt", saved.seo_title AS "seoTitle",
                        saved.meta_description AS "metaDescription", saved.price,
                        saved.old_price AS "oldPrice", saved.category, saved.image,
                        saved.images,
                        saved.stock_quantity AS "stockQuantity",
                        saved.is_available AS "isAvailable", saved.is_archived AS "isArchived", saved.shop_id AS "shopId",
                        saved.created_at AS "createdAt"
                 FROM saved CROSS JOIN request CROSS JOIN logged`,
                [record.id, record.name, record.description, record.imageAlt, record.seoTitle,
                    record.metaDescription, record.price, record.oldPrice, record.category,
                    record.image, record.stockQuantity, record.isAvailable, record.shopId, record.images,
                    req.admin.sub, req.admin.userId, idempotencyKey, requestFingerprint]
            );
            commitAttempted = true;
            await client.query('COMMIT');
            transactionOpen = false;
            imagesPersisted = true;
            const saved = rows[0];
            const published = addManagedProduct(saved);
            return res.status(201).json({ data: published });
        } catch (error) {
            let rollbackFailure;
            if (transactionOpen) {
                await client.query('ROLLBACK').catch((rollbackError) => {
                    rollbackFailure = rollbackError;
                    console.error('Could not roll back product creation:', rollbackError.message);
                });
                transactionOpen = false;
            }
            if (commitAttempted && !imagesPersisted) {
                client?.release(rollbackFailure);
                client = null;
                try {
                    const recoveryClient = await pool.connect();
                    let recoveryTransactionOpen = false;
                    let recoveryFailure;
                    let recoveredProduct;
                    try {
                        await recoveryClient.query('BEGIN');
                        recoveryTransactionOpen = true;
                        await recoveryClient.query(
                            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                            [lockScope]
                        );
                        const result = await findProductCreationReplay(
                            recoveryClient, req.shopId, req.admin.userId, idempotencyKey
                        );
                        await recoveryClient.query('COMMIT');
                        recoveryTransactionOpen = false;
                        recoveredProduct = result.rows[0];
                    } catch (recoveryError) {
                        recoveryFailure = recoveryError;
                        if (recoveryTransactionOpen) {
                            await recoveryClient.query('ROLLBACK').catch((rollbackError) => {
                                console.error('Could not roll back product commit recovery:', {
                                    name: rollbackError.name || 'Error',
                                    code: typeof rollbackError.code === 'string' ? rollbackError.code : undefined
                                });
                            });
                        }
                        throw recoveryError;
                    } finally {
                        recoveryClient.release(recoveryFailure);
                    }
                    if (recoveredProduct) {
                        if (recoveredProduct.requestFingerprint !== requestFingerprint) {
                            for (const imageFile of imageFiles) await removeUploadedFile(imageFile.path).catch((cleanupError) => {
                                console.error('Could not remove conflicting product retry image:', cleanupError.message);
                            });
                            return res.status(409).json({ error: 'This product creation key was already used for a different request.' });
                        }
                        imagesPersisted = true;
                        const saved = updateManagedProduct(recoveredProduct);
                        return res.status(201).json({ data: saved, replayed: true });
                    }
                } catch (recoveryError) {
                    commitOutcomeUnknown = true;
                    console.error('Could not resolve the product creation commit outcome; retaining uploaded images for a safe retry.', {
                        requestId: req.id,
                        name: recoveryError.name || 'Error',
                        code: typeof recoveryError.code === 'string' ? recoveryError.code : undefined
                    });
                }
            }
            if (!imagesPersisted && !commitOutcomeUnknown) for (const imageFile of imageFiles) await removeUploadedFile(imageFile.path).catch((cleanupError) => {
                console.error('Could not remove rejected product image:', cleanupError.message);
            });
            return next(error);
        } finally {
            client?.release();
        }
    });
    app.put('/api/v1/admin/products/:id', authenticateAdmin, requireShopManager, productUploadLimit, productImagesUpload, async (req, res, next) => {
        const imageFiles = [...(req.files?.images ?? []), ...(req.files?.image ?? [])];
        try {
            const id = req.params.id;
            if (!isManagedProductId(id)) throw new ProductNotFoundError();
            const product = validateManagedProduct(req.body, imageFiles, {
                requireImage: false,
                requireCompleteDetails: false
            });
            const current = await pool.query(
                'SELECT stock_quantity AS "stockQuantity" FROM managed_products WHERE id = $1 AND shop_id = $2',
                [id, req.shopId]
            );
            if (!current.rows[0]) throw new ProductNotFoundError();
            if (Number(current.rows[0].stockQuantity) !== product.stockQuantity) {
                throw new ProductInputError('Stock changes must use the inventory adjustment endpoint.');
            }
            if (product.category !== 'uncategorized') {
                const category = await pool.query(
                    'SELECT id FROM shop_product_categories WHERE shop_id = $1 AND id = $2 AND is_active = TRUE',
                    [req.shopId, product.category]
                );
                if (!category.rows[0]) throw new ProductInputError('Choose a valid product category.');
            }
            for (const imageFile of imageFiles) {
                if (!await validImageSignature(imageFile)) {
                    throw new ProductInputError('The uploaded file does not match its JPEG, PNG, or WebP image type.');
                }
            }
            const replaceImages = imageFiles.length > 0 || product.imageUrls.length > 0;
            const imageUrls = replaceImages
                ? [...imageFiles.map((file) => `/uploads/${file.filename}`), ...product.imageUrls]
                : null;
            const imageUrl = imageUrls?.[0] ?? null;
            const { rows } = await pool.query(
                `WITH previous AS MATERIALIZED (
                    SELECT image, images FROM managed_products WHERE id = $6 AND shop_id = $9
                 ),
                 updated AS (
                     UPDATE managed_products
                     SET name = $1, description = $2, price = $3, old_price = $4,
                         category = $5, is_available = $7,
                         image = COALESCE($8, image), images = COALESCE($14, images), image_alt = $11,
                         seo_title = $12, meta_description = $13
                     WHERE id = $6 AND shop_id = $9
                     RETURNING id, name, description, image_alt AS "imageAlt",
                               seo_title AS "seoTitle", meta_description AS "metaDescription",
                               price, old_price AS "oldPrice",
                               category, image, images, stock_quantity AS "stockQuantity",
                               is_available AS "isAvailable", is_archived AS "isArchived", shop_id AS "shopId",
                               created_at AS "createdAt"
                 ),
                 logged AS (
                     INSERT INTO shop_activity_logs
                         (shop_id, actor_email, action, entity_type, entity_id, details)
                     SELECT "shopId", $10, 'product.updated', 'product', id,
                            jsonb_build_object('name', name)
                     FROM updated
                     RETURNING id
                 )
                 SELECT updated.*, previous.image AS "previousImage", previous.images AS "previousImages"
                 FROM updated CROSS JOIN previous CROSS JOIN logged`,
                [product.name, product.description, product.price, product.oldPrice, product.category, id,
                    product.isAvailable, imageUrl, req.shopId, req.admin.sub,
                    product.imageAlt, product.seoTitle, product.metaDescription, imageUrls]
            );
            const saved = rows[0];
            if (!saved) throw new ProductNotFoundError();
            const published = updateManagedProduct(saved);
            const previousImages = [...new Set([saved.previousImage, ...(saved.previousImages ?? [])])];
            const nextImages = new Set(saved.images ?? [saved.image]);
            const previousImagePaths = replaceImages
                ? previousImages.filter((image) => !nextImages.has(image))
                    .map((image) => managedImagePath(uploadsDirectory, image)).filter(Boolean)
                : [];
            let warning;
            for (const previousImagePath of previousImagePaths) {
                await removeUploadedFile(previousImagePath).catch((cleanupError) => {
                    console.error('Could not remove replaced product image:', cleanupError.message);
                    warning = 'Product details were saved, but the previous image could not be deleted. Review the server logs.';
                });
            }
            return res.json({ data: published, ...(warning ? { warning } : {}) });
        } catch (error) {
            for (const imageFile of imageFiles) {
                await removeUploadedFile(imageFile.path).catch((cleanupError) => {
                    console.error('Could not remove rejected product image:', cleanupError.message);
                });
            }
            return next(error);
        }
    });
    app.patch('/api/v1/admin/products/:id/archive', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const id = req.params.id;
        const archived = req.body?.archived;
        if (!isManagedProductId(id) || typeof archived !== 'boolean') {
            return res.status(400).json({ error: 'Choose whether to archive or restore this product.' });
        }
        try {
            const { rows } = await pool.query(
                `WITH updated AS (
                    UPDATE managed_products
                    SET is_archived = $1
                    WHERE id = $2 AND shop_id = $3 AND is_archived <> $1
                    RETURNING id, name, description, image_alt AS "imageAlt",
                              seo_title AS "seoTitle", meta_description AS "metaDescription",
                              price, old_price AS "oldPrice", category, image, images,
                              stock_quantity AS "stockQuantity", is_available AS "isAvailable",
                              is_archived AS "isArchived", shop_id AS "shopId",
                              created_at AS "createdAt"
                 ), logged AS (
                    INSERT INTO shop_activity_logs
                        (shop_id, actor_email, action, entity_type, entity_id, details)
                    SELECT "shopId", $4, CASE WHEN $1 THEN 'product.archived' ELSE 'product.restored' END,
                           'product', id, jsonb_build_object('name', name)
                    FROM updated
                    RETURNING id
                 )
                 SELECT updated.* FROM updated CROSS JOIN logged`,
                [archived, id, req.shopId, req.admin.sub]
            );
            let product = rows[0];
            if (!product) {
                const current = await pool.query(
                    `SELECT id, name, description, image_alt AS "imageAlt",
                            seo_title AS "seoTitle", meta_description AS "metaDescription",
                            price, old_price AS "oldPrice", category, image, images,
                            stock_quantity AS "stockQuantity", is_available AS "isAvailable",
                            is_archived AS "isArchived", shop_id AS "shopId",
                            created_at AS "createdAt"
                     FROM managed_products WHERE id = $1 AND shop_id = $2`,
                    [id, req.shopId]
                );
                product = current.rows[0];
                if (!product) throw new ProductNotFoundError();
            }
            return res.json({ data: updateManagedProduct(product) });
        } catch (error) {
            return next(error);
        }
    });
    app.delete('/api/v1/admin/products/:id', authenticateAdmin, requireShopManager, (_req, res) => {
        return res.status(405).json({ error: 'Products cannot be permanently deleted. Archive the product instead.' });
    });
    app.get('/api/v1/admin/products/:id/inventory-adjustments', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const productId = req.params.id;
        const limitValue = req.query.limit === undefined ? '20' : req.query.limit;
        const offsetValue = req.query.offset === undefined ? '0' : req.query.offset;
        if (!isManagedProductId(productId)) return res.status(404).json({ error: 'Product not found.' });
        if (typeof limitValue !== 'string' || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100) {
            return res.status(400).json({ error: 'Inventory history limit must be an integer from 1 to 100.' });
        }
        if (typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(offsetValue)) {
            return res.status(400).json({ error: 'Inventory history offset must be a non-negative integer.' });
        }
        const limit = Number(limitValue);
        const offset = Number(offsetValue);
        try {
            const product = await pool.query(
                'SELECT id FROM managed_products WHERE id = $1 AND shop_id = $2',
                [productId, req.shopId]
            );
            if (!product.rows[0]) return res.status(404).json({ error: 'Product not found.' });
            const [history, count] = await Promise.all([
                pool.query(
                    `SELECT id, delta, previous_quantity AS "previousQuantity",
                            new_quantity AS "newQuantity", reason,
                            actor_email AS "actorEmail", request_id AS "requestId",
                            created_at AS "createdAt"
                     FROM inventory_adjustments
                     WHERE shop_id = $1 AND product_id = $2
                     ORDER BY created_at DESC, id DESC
                     LIMIT $3 OFFSET $4`,
                    [req.shopId, productId, limit, offset]
                ),
                pool.query(
                    'SELECT COUNT(*)::int AS total FROM inventory_adjustments WHERE shop_id = $1 AND product_id = $2',
                    [req.shopId, productId]
                )
            ]);
            const total = count.rows[0]?.total ?? 0;
            return res.json({
                data: history.rows.map(normalizeInventoryAdjustment),
                pagination: { limit, offset, total, hasMore: offset + history.rows.length < total }
            });
        } catch (error) {
            return next(error);
        }
    });
    app.post('/api/v1/admin/products/:id/inventory-adjustments', authenticateAdmin, requireShopManager, async (req, res, next) => {
        const productId = req.params.id;
        const { delta, idempotencyKey } = req.body ?? {};
        const reason = typeof req.body?.reason === 'string'
            ? req.body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
            : '';
        if (!isManagedProductId(productId)) return res.status(404).json({ error: 'Product not found.' });
        if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
            return res.status(400).json({ error: 'Stock adjustment must be a non-zero whole number between -1000000 and 1000000.' });
        }
        if (reason.length < 8 || reason.length > 500) {
            return res.status(400).json({ error: 'Enter an inventory adjustment reason between 8 and 500 characters.' });
        }
        if (!isUuid(idempotencyKey)) {
            return res.status(400).json({ error: 'A valid idempotency key is required for each inventory adjustment.' });
        }

        let client;
        let transactionOpen = false;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            transactionOpen = true;
            await client.query(
                'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
                [req.shopId, idempotencyKey]
            );
            const previousRequest = await client.query(
                `SELECT product_id AS "productId", delta, reason,
                        previous_quantity AS "previousQuantity",
                        new_quantity AS "newQuantity", created_at AS "createdAt"
                 FROM inventory_adjustments
                 WHERE shop_id = $1 AND idempotency_key = $2`,
                [req.shopId, idempotencyKey]
            );
            if (previousRequest.rows[0]) {
                const saved = previousRequest.rows[0];
                if (saved.productId !== productId || Number(saved.delta) !== delta || saved.reason !== reason) {
                    await client.query('ROLLBACK');
                    transactionOpen = false;
                    return res.status(409).json({ error: 'This idempotency key was already used for a different inventory adjustment.' });
                }
                await client.query('COMMIT');
                transactionOpen = false;
                return res.json({ data: { ...normalizeInventoryAdjustment(saved), replayed: true } });
            }

            const selected = await client.query(
                `SELECT id, stock_quantity AS "stockQuantity"
                 FROM managed_products
                 WHERE id = $1 AND shop_id = $2
                 FOR UPDATE`,
                [productId, req.shopId]
            );
            const product = selected.rows[0];
            if (!product) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ error: 'Product not found.' });
            }
            const previousQuantity = Number(product.stockQuantity);
            const newQuantity = previousQuantity + delta;
            if (!Number.isSafeInteger(previousQuantity) || !Number.isSafeInteger(newQuantity) || newQuantity < 0) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(409).json({ error: 'The adjustment would make stock negative or exceed the supported quantity.' });
            }

            const updated = await client.query(
                `UPDATE managed_products
                 SET stock_quantity = $1
                 WHERE id = $2 AND shop_id = $3
                 RETURNING stock_quantity AS "stockQuantity"`,
                [newQuantity, productId, req.shopId]
            );
            if (!updated.rows[0]) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ error: 'Product not found.' });
            }
            const { rows } = await client.query(
                `INSERT INTO inventory_adjustments
                    (shop_id, product_id, actor_user_id, actor_email, idempotency_key,
                     request_id, delta, previous_quantity, new_quantity, reason)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING product_id AS "productId", delta,
                           previous_quantity AS "previousQuantity",
                           new_quantity AS "newQuantity", reason,
                           created_at AS "createdAt"`,
                [req.shopId, productId, req.admin.userId, req.admin.sub, idempotencyKey,
                    req.id, delta, previousQuantity, newQuantity, reason]
            );
            await client.query('COMMIT');
            transactionOpen = false;
            updateManagedStock([{ id: productId, stockQuantity: updated.rows[0].stockQuantity }]);
            return res.status(201).json({ data: { ...normalizeInventoryAdjustment(rows[0]), replayed: false } });
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Could not roll back inventory adjustment:', {
                    name: rollbackError.name || 'Error',
                    code: typeof rollbackError.code === 'string' ? rollbackError.code : undefined
                });
            });
            return next(error);
        } finally {
            client?.release();
        }
    });
    app.get('/healthz', async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await pool.query('SELECT 1');
            return res.json({ status: 'ok' });
        } catch (error) {
            console.error('Readiness check failed:', {
                name: error.name || 'Error',
                code: typeof error.code === 'string' ? error.code : undefined
            });
            return res.status(503).json({ status: 'unavailable' });
        }
    });

    registerPlatformRoutes(app, {
        pool,
        authenticateAdmin,
        uploadProductImage,
        validImageSignature,
        removeUploadedFile,
        uploadsDirectory,
        productUploadLimit,
        vapidPublicKey: config.vapidPublicKey,
        vapidPrivateKey: config.vapidPrivateKey,
        vapidSubject: config.vapidSubject,
        adminSettingsEncryptionKey: config.adminSettingsEncryptionKey
    });

    app.post('/api/v1/orders', orderLimit, async (req, res, next) => {
        let client;
        let transactionOpen = false;
        let requestHash;
        const shopId = req.body?.shopId ?? DEFAULT_SHOP_ID;
        try {
            if (!isUuid(shopId)) {
                return res.status(400).json({ error: 'Choose a valid shop before placing the order.' });
            }
            const shop = await pool.query(
                `SELECT advance_charge FROM shops WHERE id = $1 AND status = 'active'`,
                [shopId]
            );
            if (!shop.rows[0]) return res.status(404).json({ error: 'Shop not found or unavailable.' });
            const advanceCharge = Number(shop.rows[0].advance_charge);
            client = await pool.connect();
            await client.query('BEGIN');
            transactionOpen = true;
            const managedProductIds = [...new Set((Array.isArray(req.body?.items) ? req.body.items : [])
                .map((item) => item?.productId)
                .filter((id) => typeof id === 'string' && id.startsWith('admin-')))].sort();
            const managedProducts = new Map();
            if (managedProductIds.length) {
                const { rows } = await client.query(
                    `SELECT id, name, price, old_price AS "oldPrice", category,
                            stock_quantity AS "stockQuantity", is_available AS "isAvailable",
                            is_archived AS "isArchived", shop_id AS "shopId"
                     FROM managed_products
                     WHERE id = ANY($1::TEXT[]) AND shop_id = $2
                     ORDER BY id
                     FOR UPDATE`,
                    [managedProductIds, shopId]
                );
                for (const product of rows) {
                    managedProducts.set(String(product.id), {
                        ...product,
                        price: Number(product.price),
                        oldPrice: product.oldPrice === null ? null : Number(product.oldPrice),
                        stockQuantity: Number(product.stockQuantity)
                    });
                }
            }
            const productLookup = (productId, requestedShopId) => {
                if (typeof productId === 'string' && productId.startsWith('admin-')) {
                    return managedProducts.get(productId);
                }
                return findProductForShop(productId, requestedShopId);
            };
            const order = validateAndPriceOrder(req.body, advanceCharge, {
                checkInventory: false,
                shopId,
                productLookup
            });
            requestHash = createHash('sha256').update(fingerprintOrder(order)).digest('hex');
            const existing = await client.query(
                `SELECT order_number, request_hash, customer_name, phone, address, bkash_number, items,
                        advance_amount, subtotal, advance_amount AS "advanceAmount", due_amount AS due
                 FROM orders WHERE event_id = $1 AND shop_id = $2 FOR UPDATE`,
                [order.eventId, shopId]
            );
            if (existing.rows[0]) {
                await client.query('COMMIT');
                transactionOpen = false;
                return respondWithExistingOrder(res, existing.rows[0], requestHash);
            }
            if (order.items.some(({ productId }) => managedProducts.get(String(productId))?.isArchived)) {
                throw new OrderInputError('An order contains an invalid product or quantity.');
            }
            const inventory = await changeManagedStock(client, order.items, true);
            const inserted = await client.query(
                `INSERT INTO orders
                    (order_number, event_id, request_hash, customer_name, phone, address, bkash_number, items,
                     subtotal, advance_amount, due_amount, inventory_reserved, shop_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
                 ON CONFLICT (shop_id, event_id) DO NOTHING
                 RETURNING order_number, request_hash, subtotal, advance_amount AS "advanceAmount", due_amount AS due`,
                [order.orderNumber, order.eventId, requestHash, order.customerName, order.phone, order.address, order.bkashNumber,
                    JSON.stringify(order.items), order.subtotal, order.advanceAmount, order.dueAmount, inventory.reserved, shopId]
            );
            if (!inserted.rows.length) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                const saved = (await pool.query(
                    `SELECT order_number, request_hash, customer_name, phone, address, bkash_number, items,
                            advance_amount, subtotal, advance_amount AS "advanceAmount", due_amount AS due
                     FROM orders WHERE event_id = $1 AND shop_id = $2`,
                    [order.eventId, shopId]
                )).rows[0];
                return respondWithExistingOrder(res, saved, requestHash);
            }
            await client.query(
                `INSERT INTO shop_activity_logs
                    (shop_id, actor_email, action, entity_type, entity_id, details)
                 VALUES ($1, 'customer', 'order.created', 'order', $2, $3::jsonb)`,
                [shopId, inserted.rows[0].order_number, JSON.stringify({ subtotal: order.subtotal, itemCount: order.items.length })]
            );
            await client.query('COMMIT');
            transactionOpen = false;
            updateManagedStock(inventory.updates);
            const saved = inserted.rows[0];
            return res.status(201).json({
                data: { orderNumber: saved.order_number, subtotal: Number(saved.subtotal), advanceAmount: Number(saved.advanceAmount), due: Number(saved.due) }
            });
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Could not roll back checkout inventory reservation:', {
                    name: rollbackError.name || 'Error',
                    code: typeof rollbackError.code === 'string' ? rollbackError.code : undefined
                });
            });
            if (error instanceof InventoryUnavailableError) {
                let saved;
                try {
                    saved = (await pool.query(
                        `SELECT order_number, request_hash, customer_name, phone, address, bkash_number, items,
                                advance_amount, subtotal, advance_amount AS "advanceAmount", due_amount AS due
                         FROM orders WHERE event_id = $1 AND shop_id = $2`,
                        [req.body?.eventId, shopId]
                    )).rows[0];
                } catch (lookupError) {
                    return next(lookupError);
                }
                if (saved) return respondWithExistingOrder(res, saved, requestHash);
            }
            return next(error);
        } finally {
            client?.release();
        }
    });

    app.post('/api/v1/customer/order-lookup', orderLookupLimit, async (req, res, next) => {
        const orderNumber = typeof req.body?.orderNumber === 'string' ? req.body.orderNumber.trim().toUpperCase() : '';
        const phone = normalizePhone(req.body?.phone);
        if (!/^SH-[A-Z0-9]{1,12}-(?:[A-Z0-9]{4}|[A-F0-9]{12})$/.test(orderNumber)
            || !/^01[3-9]\d{8}$/.test(phone)) {
            return res.status(400).json({ error: 'Enter a valid order number and Bangladesh mobile number.' });
        }
        try {
            const { rows } = await pool.query(
                `SELECT order_number AS "orderNumber", status, items, subtotal,
                        advance_amount AS "advanceAmount", due_amount AS due,
                        advance_payment_status AS "advancePaymentStatus", created_at AS "createdAt"
                 FROM orders
                 WHERE order_number = $1 AND phone = $2`,
                [orderNumber, phone]
            );
            const order = rows[0];
            if (!order) {
                return res.status(404).json({ error: 'We could not find an order matching those details. Check them and try again.' });
            }
            return res.json({
                data: {
                    orderNumber: order.orderNumber,
                    status: order.status,
                    items: order.items.map((item) => ({
                        name: item.name,
                        quantity: Number(item.quantity),
                        lineTotal: Number(item.lineTotal)
                    })),
                    subtotal: Number(order.subtotal),
                    advanceAmount: Number(order.advanceAmount),
                    due: Number(order.due),
                    advancePaymentStatus: order.advancePaymentStatus,
                    createdAt: order.createdAt
                }
            });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/api/v1/admin/login', loginLimit, async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        try {
            const { rows } = await pool.query(
                `SELECT u.id, u.email, u.password_hash, u.mfa_secret AS "mfaSecret",
                        u.mfa_enabled AS "mfaEnabled", u.last_mfa_counter AS "lastMfaCounter",
                        u.session_version AS "sessionVersion",
                        (pa.user_id IS NOT NULL) AS "isPlatformAdmin"
                 FROM admin_users u
                 LEFT JOIN platform_admins pa ON pa.user_id = u.id
                 WHERE u.email = $1`,
                [email]
            );
            const account = rows[0];
            if (!account || !await verifyAdminPassword(password, account.password_hash)) {
                return res.status(401).json({ error: 'Email or password is incorrect.' });
            }
            if (platformAdminMfaRequired && account.isPlatformAdmin && !account.mfaEnabled) {
                const secret = generateTotpSecret();
                const setupToken = jwt.sign({
                    sub: account.email,
                    userId: account.id,
                    purpose: 'mfa-enrollment',
                    encryptedSecret: encryptTotpSecret(secret, config.mfaEncryptionKey)
                }, config.jwtSecret, {
                    algorithm: 'HS256',
                    expiresIn: '10m',
                    issuer: 'shopademia-mfa'
                });
                return res.json({
                    mfaSetupRequired: true,
                    setupToken,
                    totpSecret: secret,
                    provisioningUri: totpProvisioningUri(secret, account.email)
                });
            }
            if (platformAdminMfaRequired && account.isPlatformAdmin) {
                let secret;
                try {
                    secret = decryptTotpSecret(account.mfaSecret, config.mfaEncryptionKey);
                } catch (error) {
                    return next(error);
                }
                const counter = verifyTotpCode(secret, req.body?.totpCode);
                if (counter === null) {
                    return res.status(401).json({ error: 'Email, password, or authenticator code is incorrect.' });
                }
                const consumedCode = await pool.query(
                    `UPDATE admin_users SET last_mfa_counter = $1
                     WHERE id = $2 AND mfa_enabled = TRUE AND last_mfa_counter < $1
                     RETURNING id`,
                    [counter, account.id]
                );
                if (!consumedCode.rows[0]) {
                    return res.status(401).json({ error: 'Email, password, or authenticator code is incorrect.' });
                }
            }
            let shopId = null;
            if (!account.isPlatformAdmin) {
                const membership = await pool.query(
                    `SELECT m.shop_id AS "shopId"
                     FROM shop_memberships m
                     JOIN shops s ON s.id = m.shop_id
                     WHERE m.user_id = $1 AND s.status = 'active'
                     ORDER BY s.created_at, s.id LIMIT 1`,
                    [account.id]
                );
                shopId = membership.rows[0]?.shopId;
                if (!shopId) return res.status(403).json({ error: 'This account has no active shop access.' });
            }
            await pool.query(
                `DELETE FROM admin_sessions
                 WHERE expires_at <= NOW() OR revoked_at < NOW() - INTERVAL '7 days'`
            );
            const tokenId = randomUUID();
            const token = jwt.sign({
                sub: account.email,
                role: 'admin',
                userId: account.id,
                ...(shopId ? { shopId } : {}),
                isPlatformAdmin: account.isPlatformAdmin,
                sessionVersion: Number(account.sessionVersion)
            }, config.jwtSecret, {
                algorithm: 'HS256', expiresIn: '8h', issuer: 'shopademia', jwtid: tokenId
            });
            await pool.query(
                `INSERT INTO admin_sessions (token_id, expires_at, user_id, shop_id)
                 VALUES ($1, NOW() + INTERVAL '8 hours', $2, $3)`,
                [tokenId, account.id, shopId]
            );
            setAdminCookie(res, token, 8 * 60 * 60, secureAdminCookie);
            if (shopId) {
                await pool.query(
                    `INSERT INTO shop_activity_logs
                        (shop_id, actor_email, action, entity_type, entity_id, details)
                     VALUES ($1, $2, 'auth.login', 'admin_user', $3, '{}'::jsonb)`,
                    [shopId, account.email, account.id]
                );
            }
            return res.json({
                ...(!req.get('origin') ? { token } : {}),
                expiresIn: 28800
            });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/api/v1/admin/mfa/enroll', loginLimit, async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const setupToken = typeof req.body?.setupToken === 'string' ? req.body.setupToken : '';
        const code = req.body?.totpCode;
        let challenge;
        try {
            challenge = jwt.verify(setupToken, config.jwtSecret, {
                algorithms: ['HS256'],
                issuer: 'shopademia-mfa'
            });
        } catch {
            return res.status(401).json({ error: 'The MFA setup session expired. Sign in again.' });
        }
        if (challenge.purpose !== 'mfa-enrollment'
            || typeof challenge.userId !== 'string'
            || typeof challenge.sub !== 'string'
            || typeof challenge.encryptedSecret !== 'string') {
            return res.status(401).json({ error: 'The MFA setup session is invalid. Sign in again.' });
        }
        try {
            const secret = decryptTotpSecret(challenge.encryptedSecret, config.mfaEncryptionKey);
            const counter = verifyTotpCode(secret, code);
            if (counter === null) {
                return res.status(400).json({ error: 'Enter the current six-digit code from your authenticator app.' });
            }
            const updated = await pool.query(
                `UPDATE admin_users AS u
                 SET mfa_secret = $1, mfa_enabled = TRUE, last_mfa_counter = $2, updated_at = NOW()
                 WHERE u.id = $3 AND u.email = $4 AND u.mfa_enabled = FALSE
                   AND EXISTS (SELECT 1 FROM platform_admins WHERE user_id = u.id)
                 RETURNING u.id, u.email, u.session_version AS "sessionVersion"`,
                [challenge.encryptedSecret, counter, challenge.userId, challenge.sub]
            );
            const account = updated.rows[0];
            if (!account) return res.status(409).json({ error: 'MFA is already enabled or this account is no longer a platform administrator.' });
            await revokeAdminSessions(pool, account.id);
            const tokenId = randomUUID();
            const token = jwt.sign({
                sub: account.email,
                role: 'admin',
                userId: account.id,
                isPlatformAdmin: true,
                sessionVersion: Number(account.sessionVersion)
            }, config.jwtSecret, {
                algorithm: 'HS256', expiresIn: '8h', issuer: 'shopademia', jwtid: tokenId
            });
            await pool.query(
                `INSERT INTO admin_sessions (token_id, expires_at, user_id, shop_id)
                 VALUES ($1, NOW() + INTERVAL '8 hours', $2, NULL)`,
                [tokenId, account.id]
            );
            setAdminCookie(res, token, 8 * 60 * 60, secureAdminCookie);
            return res.json({
                ...(!req.get('origin') ? { token } : {}),
                expiresIn: 28800
            });
        } catch (error) {
            return next(error);
        }
    });

    app.get('/api/v1/admin/profile', authenticateAdmin, async (req, res, next) => {
        try {
            const { rows } = await pool.query('SELECT email FROM admin_users WHERE id = $1', [req.admin.userId]);
            if (!rows[0]) return res.status(404).json({ error: 'Admin profile not found.' });
            return res.json({
                data: {
                    email: rows[0].email,
                    userId: req.admin.userId,
                    shopId: req.shopId,
                    role: req.shopRole,
                    isPlatformAdmin: req.isPlatformAdmin
                }
            });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/api/v1/admin/logout', authenticateAdmin, async (req, res, next) => {
        try {
            await pool.query(
                'UPDATE admin_sessions SET revoked_at = NOW() WHERE token_id = $1 AND revoked_at IS NULL',
                [req.admin.jti]
            );
            clearAdminCookie(res, secureAdminCookie);
            if (req.shopId) {
                await pool.query(
                    `INSERT INTO shop_activity_logs
                        (shop_id, actor_email, action, entity_type, entity_id, details)
                     VALUES ($1, $2, 'auth.logout', 'admin_user', $3, '{}'::jsonb)`,
                    [req.shopId, req.admin.sub, req.admin.userId]
                );
            }
            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    app.get('/api/v1/admin/orders/:id/activity', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        const orderId = String(req.params.id);
        if (!/^\d{1,18}$/.test(orderId)) return res.status(404).json({ error: 'Order not found.' });
        try {
            const { rows } = await pool.query(
                `SELECT id, actor_email AS "actorEmail", action,
                        previous_value AS "previousValue", new_value AS "newValue",
                        created_at AS "createdAt"
                 FROM admin_order_events
                 WHERE order_id = $1
                   AND EXISTS (SELECT 1 FROM orders WHERE id = $1 AND shop_id = $2)
                 ORDER BY id DESC
                 LIMIT 100`,
                [orderId, req.shopId]
            );
            return res.json({ data: rows });
        } catch (error) {
            return next(error);
        }
    });

    app.get('/api/v1/admin/orders/:id', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        const orderId = String(req.params.id);
        if (!/^\d{1,18}$/.test(orderId)) return res.status(404).json({ error: 'Order not found.' });
        try {
            const { rows } = await pool.query(
                `SELECT id, order_number AS "orderNumber", customer_name AS "customerName", phone, address,
                        bkash_number AS "bkashNumber", items, subtotal, advance_amount AS "advanceAmount",
                        due_amount AS due, status, advance_payment_status AS "advancePaymentStatus",
                        advance_payment_checked_at AS "advancePaymentCheckedAt",
                        advance_payment_checked_by AS "advancePaymentCheckedBy",
                        created_at AS "createdAt", updated_at AS "updatedAt"
                 FROM orders WHERE id = $1 AND shop_id = $2`,
                [orderId, req.shopId]
            );
            if (!rows[0]) return res.status(404).json({ error: 'Order not found.' });
            return res.json({ data: rows[0] });
        } catch (error) {
            return next(error);
        }
    });

    app.patch('/api/v1/admin/profile/password', authenticateAdmin, passwordChangeLimit, async (req, res, next) => {
        const currentPassword = req.body?.currentPassword;
        const newPassword = req.body?.newPassword;
        if (typeof currentPassword !== 'string' || !currentPassword
            || typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 1024) {
            return res.status(400).json({ error: 'Enter your current password and a new password of at least 12 characters.' });
        }
        try {
            const { rows } = await pool.query(
                'SELECT password_hash FROM admin_users WHERE id = $1',
                [req.admin.userId]
            );
            const account = rows[0];
            if (!account || !await verifyAdminPassword(currentPassword, account.password_hash)) {
                return res.status(403).json({ error: 'Current password is incorrect.' });
            }
            if (await verifyAdminPassword(newPassword, account.password_hash)) {
                return res.status(400).json({ error: 'Choose a new password that differs from your current password.' });
            }
            const passwordHash = await hashAdminPassword(newPassword);
            const updated = await pool.query(
                `UPDATE admin_users
                 SET password_hash = $1, session_version = session_version + 1, updated_at = NOW()
                 WHERE id = $2 AND password_hash = $3
                 RETURNING id, email`,
                [passwordHash, req.admin.userId, account.password_hash]
            );
            if (!updated.rows[0]) {
                return res.status(409).json({ error: 'Your password changed in another session. Sign in again and retry.' });
            }
            await revokeAdminSessions(pool, updated.rows[0].id, null);
            if (req.shopId) {
                await pool.query(
                    `INSERT INTO shop_activity_logs
                        (shop_id, actor_email, action, entity_type, entity_id, details)
                     VALUES ($1, $2, 'account.password_changed', 'admin_user', $3, '{}'::jsonb)`,
                    [req.shopId, req.admin.sub, updated.rows[0].id]
                );
            }
            return res.json({ data: { email: updated.rows[0].email, sessionInvalidated: true } });
        } catch (error) {
            return next(error);
        }
    });

    app.get('/api/v1/admin/orders', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        try {
            const status = req.query.status === undefined ? '' : req.query.status;
            if (typeof status !== 'string') return res.status(400).json({ error: 'Invalid order status filter.' });
            if (status && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid order status filter.' });
            const search = req.query.search === undefined ? '' : req.query.search;
            if (typeof search !== 'string' || search.length > 100) {
                return res.status(400).json({ error: 'Order search must be at most 100 characters.' });
            }
            const pageValue = req.query.page === undefined ? '1' : req.query.page;
            const limitValue = req.query.limit === undefined ? '20' : req.query.limit;
            if (typeof pageValue !== 'string' || !/^[1-9]\d{0,5}$/.test(pageValue) || Number(pageValue) > 100000) {
                return res.status(400).json({ error: 'Order page must be an integer from 1 to 100000.' });
            }
            if (typeof limitValue !== 'string' || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100) {
                return res.status(400).json({ error: 'Order limit must be an integer from 1 to 100.' });
            }
            const page = Number(pageValue);
            const limit = Number(limitValue);
            const offset = (page - 1) * limit;
            const filters = ['shop_id = $1'];
            const values = [req.shopId];
            if (status) {
                values.push(status);
                filters.push(`status = $${values.length}`);
            }
            const normalizedSearch = search.trim();
            if (normalizedSearch) {
                const escapedSearch = normalizedSearch.replace(/[\\%_]/g, '\\$&');
                values.push(`%${escapedSearch}%`);
                const searchParameter = `$${values.length}`;
                filters.push(`(order_number ILIKE ${searchParameter} ESCAPE E'\\\\'
                    OR customer_name ILIKE ${searchParameter} ESCAPE E'\\\\'
                    OR phone ILIKE ${searchParameter} ESCAPE E'\\\\')`);
            }
            const where = `WHERE ${filters.join(' AND ')}`;
            const [orders, counts] = await Promise.all([
                pool.query(
                    `SELECT id, order_number AS "orderNumber", customer_name AS "customerName", phone, address,
                            bkash_number AS "bkashNumber", items, subtotal, advance_amount AS "advanceAmount",
                            due_amount AS due, status, advance_payment_status AS "advancePaymentStatus",
                            advance_payment_checked_at AS "advancePaymentCheckedAt",
                            advance_payment_checked_by AS "advancePaymentCheckedBy",
                            created_at AS "createdAt", updated_at AS "updatedAt"
                     FROM orders ${where}
                     ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
                    [...values, limit, offset]
                ),
                pool.query(`SELECT COUNT(*)::int AS total FROM orders ${where}`, values)
            ]);
            return res.json({ data: orders.rows, page, limit, total: counts.rows[0].total });
        } catch (error) {
            return next(error);
        }
    });

    app.patch('/api/v1/admin/orders/:id/advance-payment', authenticateAdmin, requireShopDashboard, async (req, res, next) => {
        try {
            const { status } = req.body ?? {};
            if (!['verified', 'rejected'].includes(status)) {
                return res.status(400).json({ error: 'Choose whether the advance payment was verified or rejected.' });
            }
            const orderId = String(req.params.id);
            if (!/^\d{1,18}$/.test(orderId)) return res.status(404).json({ error: 'Order not found.' });
            const result = await pool.query(
                `WITH previous AS MATERIALIZED (
                     SELECT id, advance_payment_status
                     FROM orders
                     WHERE id = $2 AND shop_id = $4
                     FOR UPDATE
                 ),
                 updated AS (
                     UPDATE orders o
                     SET advance_payment_status = $1,
                         advance_payment_checked_at = NOW(),
                         advance_payment_checked_by = $3,
                         updated_at = NOW()
                     FROM previous p
                     WHERE o.id = p.id
                     RETURNING o.id, o.order_number AS "orderNumber",
                               o.advance_payment_status AS "advancePaymentStatus",
                               o.advance_payment_checked_at AS "advancePaymentCheckedAt",
                               o.advance_payment_checked_by AS "advancePaymentCheckedBy",
                               p.advance_payment_status AS previous_status
                 ),
                 logged AS (
                     INSERT INTO admin_order_events
                         (order_id, actor_email, action, previous_value, new_value)
                     SELECT id, $3, 'advance_payment_reviewed', previous_status, "advancePaymentStatus"
                     FROM updated
                     WHERE previous_status <> "advancePaymentStatus"
                     RETURNING id
                 ), shop_logged AS (
                     INSERT INTO shop_activity_logs
                         (shop_id, actor_email, action, entity_type, entity_id, details)
                     SELECT $4, $3, 'order.advance_payment_reviewed', 'order', id,
                            jsonb_build_object('from', previous_status, 'to', "advancePaymentStatus")
                     FROM updated
                     WHERE previous_status <> "advancePaymentStatus"
                     RETURNING id
                 )
                 SELECT id, "orderNumber", "advancePaymentStatus",
                        "advancePaymentCheckedAt", "advancePaymentCheckedBy"
                 FROM updated`,
                [status, orderId, req.admin.sub, req.shopId]
            );
            if (!result.rows[0]) return res.status(404).json({ error: 'Order not found.' });
            return res.json({ data: result.rows[0] });
        } catch (error) {
            return next(error);
        }
    });

    app.patch('/api/v1/admin/orders/:id/status', authenticateAdmin, requireShopManager, async (req, res, next) => {
        let client;
        let transactionOpen = false;
        try {
            const { status } = req.body ?? {};
            if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
            const orderId = String(req.params.id);
            if (!/^\d{1,18}$/.test(orderId)) return res.status(404).json({ error: 'Order not found.' });
            client = await pool.connect();
            await client.query('BEGIN');
            transactionOpen = true;
            const previous = (await client.query(
                `SELECT id, status, items, inventory_reserved AS "inventoryReserved"
                 FROM orders WHERE id = $1 AND shop_id = $2 FOR UPDATE`,
                [orderId, req.shopId]
            )).rows[0];
            if (!previous) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(404).json({ error: 'Order not found.' });
            }
            if (!canTransitionOrderStatus(previous.status, status)) {
                await client.query('ROLLBACK');
                transactionOpen = false;
                return res.status(409).json({
                    error: `Order status cannot change from ${previous.status} to ${status}.`
                });
            }
            let inventoryReserved = previous.inventoryReserved;
            let stockUpdates = [];
            if (previous.status !== status && status === 'cancelled' && inventoryReserved) {
                const inventory = await changeManagedStock(client, previous.items, false);
                stockUpdates = inventory.updates;
                inventoryReserved = false;
            } else if (previous.status === 'cancelled' && status !== 'cancelled') {
                const inventory = await changeManagedStock(client, previous.items, true);
                stockUpdates = inventory.updates;
                inventoryReserved = inventory.reserved;
            }
            const updated = await client.query(
                `UPDATE orders
                 SET status = $1, inventory_reserved = $2, updated_at = NOW()
                 WHERE id = $3
                 RETURNING id, order_number AS "orderNumber", status, updated_at AS "updatedAt"`,
                [status, inventoryReserved, orderId]
            );
            if (previous.status !== status) {
                await client.query(
                    `INSERT INTO admin_order_events (order_id, actor_email, action, previous_value, new_value)
                     VALUES ($1, $2, 'status_changed', $3, $4)`,
                    [orderId, req.admin.sub, previous.status, status]
                );
                await client.query(
                    `INSERT INTO shop_activity_logs
                        (shop_id, actor_email, action, entity_type, entity_id, details)
                     VALUES ($1, $2, 'order.status_changed', 'order', $3, $4::jsonb)`,
                    [req.shopId, req.admin.sub, orderId, JSON.stringify({ from: previous.status, to: status })]
                );
            }
            await client.query('COMMIT');
            transactionOpen = false;
            updateManagedStock(stockUpdates);
            return res.json({ data: updated.rows[0] });
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch((rollbackError) => {
                console.error('Could not roll back order status inventory update:', {
                    name: rollbackError.name || 'Error',
                    code: typeof rollbackError.code === 'string' ? rollbackError.code : undefined
                });
            });
            return next(error);
        } finally {
            client?.release();
        }
    });

    app.use((req, res) => {
        if (req.method === 'GET' && !req.path.startsWith('/api/') && !/\.[^/]+$/.test(req.path) && req.accepts('html')) {
            return res.status(404).sendFile(join(root, '404.html'));
        }
        return res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
    });
    app.use((error, _req, res, _next) => {
        if (error instanceof OrderInputError) return res.status(400).json({ error: error.message });
        if (error instanceof ProductInputError) return res.status(400).json({ error: error.message });
        if (error instanceof ProductNotFoundError) return res.status(404).json({ error: error.message });
        if (error instanceof InventoryUnavailableError) return res.status(409).json({ error: error.message });
        if (error instanceof multer.MulterError) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            const message = error.code === 'LIMIT_FILE_SIZE'
                ? 'Uploaded images must be 5 MB or smaller.'
                : 'The upload exceeds the allowed file count or form limits.';
            return res.status(status).json({ error: message });
        }
        if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
        if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
        if (error?.status === 404 || error?.statusCode === 404) return res.status(404).json({ error: 'Not found.' });
        console.error('Request failed:', {
            name: error?.name || 'Error',
            code: typeof error?.code === 'string' ? error.code : undefined
        });
        return res.status(500).json({ error: 'The request could not be completed. Please try again.' });
    });

    return app;
}
