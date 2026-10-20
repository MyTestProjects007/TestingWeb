import { createServer } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const storefrontPath = '/?shop=main';
const trackers = /googletagmanager\.com|connect\.facebook\.net/;
const expectedSiteOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL).origin;

test('storefront announcement scrolls and displays configured plain text', async ({ page }) => {
    const announcement = 'Explore fresh finds from Shopademia';
    await page.route('**/api/v1/storefront-announcement', (route) => route.fulfill({
        json: { data: { text: announcement } }
    }));
    await page.goto(storefrontPath);

    const ticker = page.getByRole('region', { name: 'Store announcement' });
    await expect(ticker.locator('#marketplaceAnnouncementText')).toHaveText(announcement);
    await expect(ticker.locator('[data-announcement-copy]')).toHaveText(announcement);
    await expect(ticker.locator('.marketplace-announcement-copy[aria-hidden="true"]')).toBeVisible();
    expect(await ticker.locator('.marketplace-announcement-track').evaluate((element) =>
        getComputedStyle(element).animationName
    )).toBe('marketplace-announcement-slide');
    const motionToggle = ticker.locator('#announcementMotionToggle');
    await expect(motionToggle).toHaveAccessibleName('Pause announcement');
    await expect(motionToggle).toHaveAttribute('aria-pressed', 'false');
    await motionToggle.focus();
    await motionToggle.press('Space');
    await expect(motionToggle).toHaveAttribute('aria-label', 'Resume announcement');
    await expect(motionToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(ticker).toHaveClass(/is-paused/);
    await motionToggle.press('Space');
    await expect(motionToggle).toHaveAttribute('aria-label', 'Pause announcement');
    await expect(ticker).not.toHaveClass(/is-paused/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await ticker.locator('.marketplace-announcement-track').evaluate((element) =>
        getComputedStyle(element).animationName
    )).toBe('none');
    await expect(ticker.getByRole('button', { name: 'Pause announcement' })).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(motionToggle).toBeHidden();
});

test('homepage loads catalog and essential-only consent remains changeable', async ({ page }) => {
    const marketplaceProduct = {
        id: 'marketplace-home-item',
        name: 'Marketplace home item',
        description: 'A product from an independent shop.',
        price: 250,
        oldPrice: null,
        category: 'gadgets',
        stockQuantity: 4,
        isAvailable: true,
        shopId: '00000000-0000-4000-8000-000000000011',
        shopAdvanceCharge: 35,
        shopSlug: 'other-shop',
        shopName: 'Other Shop'
    };
    await page.route((url) => new URL(url).pathname === '/api/v1/products', (route) =>
        route.fulfill({ json: { data: [marketplaceProduct] } })
    );
    await page.route('**/api/v1/storefront-announcement', (route) => route.fulfill({
        json: { data: { text: 'Discover products from independent shops' } }
    }));
    const pageErrors = [];
    const trackerRequests = [];
    const sameOriginFailures = [];
    const sameOriginConsoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        const location = message.location().url;
        if (message.type() === 'error' && location
            && new URL(location).origin === expectedSiteOrigin) {
            sameOriginConsoleErrors.push(message.text());
        }
    });
    page.on('request', (request) => {
        if (trackers.test(request.url())) trackerRequests.push(request.url());
    });
    page.on('requestfailed', (request) => {
        if (new URL(request.url()).origin === expectedSiteOrigin) {
            sameOriginFailures.push(request.url());
        }
    });
    page.on('response', (response) => {
        if (new URL(response.url()).origin === expectedSiteOrigin && response.status() >= 400) {
            sameOriginFailures.push(`${response.status()} ${response.url()}`);
        }
    });

    const response = await page.goto(storefrontPath);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Shop products and deals | Main Shop | Shopademia');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${expectedSiteOrigin}/`);
    await expect(page.getByRole('heading', { name: 'Find something for every day.' })).toBeVisible();
    await expect(page.locator('#allShops, #homeShopList, .marketplace-shop-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show search results' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shop Products' })).toBeVisible();
    await expect(page.locator('#productResultsStatus')).toContainText('Showing');
    await expect(page.locator('#newArrivalsGrid [data-action="add"]').first()).toBeVisible();
    await expect(page.locator('#newArrivalsGrid [data-action="buy-now"]').first()).toBeVisible();
    const catalog = [marketplaceProduct];
    const firstCard = page.locator('#featuredProductGrid .market-product-card').first();
    await expect(firstCard).toBeVisible();
    const firstCardId = await firstCard.getAttribute('data-id');
    const firstProduct = catalog.find(({ id }) => String(id) === firstCardId);
    expect(firstProduct?.shopSlug).toBeTruthy();
    await expect(firstCard.locator('.market-product-shop'))
        .toHaveAttribute('href', `/shops/${encodeURIComponent(firstProduct.shopSlug)}`);
    if (firstProduct.shopSlug === 'main') {
        await expect(firstCard.locator('[data-action="add"]')).toBeVisible();
    } else {
        await expect(firstCard.locator('[data-action="add"]')).toBeVisible();
        await expect(firstCard.locator('[data-action="buy-now"]')).toBeVisible();
    }
    const visibleImages = page.locator('img:visible');
    for (let index = 0; index < await visibleImages.count(); index++) {
        const image = visibleImages.nth(index);
        await image.scrollIntoViewIfNeeded();
        await expect.poll(() => image.evaluate((element) => element.complete)).toBe(true);
    }
    expect(await visibleImages.evaluateAll((images) =>
        images.filter((image) => image.naturalWidth === 0).map((image) => image.currentSrc || image.src)
    )).toEqual([]);
    await firstCard.locator('[data-action="add"]').click();
    await expect(page.locator('#cartBadge')).toHaveText('1');
    await firstCard.locator('[data-action="buy-now"]').click();
    await expect(page.locator('#checkoutModal')).toBeVisible();
    await expect(page.locator('#cartBadge')).toHaveText('2');
    await expect(page.locator('#coSubtotal')).toContainText('৳');
    await expect(page.locator('#coAdvance')).toContainText('35');
    await page.locator('#checkoutCloseBtn').click();
    await expect(page.locator('#featuredProductGrid .fa-star')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show search results' }).click();
    await expect(page.locator('#productResultsStatus')).toBeFocused();
    await expect.poll(() => page.locator('.marketplace-header').evaluate((header) =>
        Math.round(header.getBoundingClientRect().top)
    )).toBe(0);
    await expect.poll(() => page.evaluate(() =>
        Math.round(document.querySelector('#shop h2').getBoundingClientRect().top
            - document.querySelector('.marketplace-header').getBoundingClientRect().bottom)
    )).toBeGreaterThanOrEqual(0);
    await page.getByRole('button', { name: 'Essential only' }).click();
    await expect(page.getByRole('button', { name: 'Essential only' })).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shopademia.privacyConsent.v1'))))
        .toMatchObject({ necessary: true, analytics: false });
    await page.getByRole('button', { name: 'Cookie settings' }).click();
    await expect(page.getByRole('button', { name: 'Allow analytics' })).toBeVisible();
    expect(trackerRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(sameOriginFailures).toEqual([]);
    expect(sameOriginConsoleErrors).toEqual([]);
});

test('new-arrival cards support adding to cart and seller-routed buy now', async ({ page }) => {
    const product = {
        id: 'arrival-purchase-item',
        name: 'Arrival purchase item',
        description: 'A new product from an independent shop.',
        price: 250,
        oldPrice: null,
        category: 'gadgets',
        stockQuantity: 4,
        isAvailable: true,
        shopId: '00000000-0000-4000-8000-000000000011',
        shopAdvanceCharge: 35,
        shopSlug: 'other-shop',
        shopName: 'Other Shop'
    };
    await page.route((url) => new URL(url).pathname === '/api/v1/products', (route) =>
        route.fulfill({ json: { data: [product] } })
    );
    await page.goto(storefrontPath);

    const card = page.locator('#newArrivalsGrid [data-id="arrival-purchase-item"]');
    const addToCart = card.getByRole('button', { name: 'Add Arrival purchase item to cart' });
    const buyNow = card.getByRole('button', { name: 'Buy Arrival purchase item now' });
    await expect(addToCart).toBeVisible();
    await expect(buyNow).toBeVisible();

    await addToCart.click();
    await expect(page.locator('#cartBadge')).toHaveText('1');
    await page.locator('#cartDrawerBtn').click();
    await expect(page.locator('#cartItemsContainer [data-id="arrival-purchase-item"]')).toBeVisible();
    await page.getByRole('button', { name: 'Remove Arrival purchase item' }).click();
    await page.locator('#closeCartBtn').click();

    await buyNow.click();
    await expect(page.locator('#checkoutModal')).toBeVisible();
    await expect(page.locator('#coAdvance')).toContainText('35');
});

test('cart items display their product image with an image fallback available', async ({ page }) => {
    const product = {
        id: 'cart-image-product',
        name: 'Cart image product',
        description: 'A product shown in the cart.',
        price: 250,
        oldPrice: null,
        category: 'gadgets',
        image: 'https://images.example.com/cart-product.png',
        imageAlt: 'Cart image product',
        icon: 'fa-box',
        stockQuantity: 4,
        isAvailable: true,
        shopSlug: 'main',
        shopName: 'Main Shop'
    };
    await page.route((url) => new URL(url).pathname === '/api/v1/products', (route) =>
        route.fulfill({ json: { data: [product] } })
    );
    await page.route(product.image, (route) => route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')
    }));

    await page.goto(storefrontPath);
    await page.locator('#featuredProductGrid [data-id="cart-image-product"] [data-action="add"]').click();
    await page.locator('#cartDrawerBtn').click();

    const cartImage = page.locator('#cartItemsContainer [data-cart-image]');
    await expect(cartImage).toBeVisible();
    await expect(cartImage).toHaveAttribute('src', product.image);
    await expect(page.locator('#cartItemsContainer [data-id="cart-image-product"] h5'))
        .toHaveText(product.name);
});

test('homepage hero keeps its message and rotates super-admin carousel images one at a time', async ({ page }) => {
    const slides = [
        {
            id: '1',
            image: 'https://images.example.com/hero-one.png',
            mobileImage: 'https://images.example.com/hero-one-mobile.png',
            headline: 'First slide metadata',
            bodyText: 'This is not shown as hero copy.',
            buttonText: 'Different button',
            targetUrl: '/different-target'
        },
        {
            id: '2',
            image: 'https://images.example.com/hero-two.png',
            mobileImage: null,
            headline: 'Second slide metadata',
            bodyText: 'This is also not shown as hero copy.',
            buttonText: 'Another button',
            targetUrl: '/another-target'
        }
    ];
    await page.route('**/api/v1/shops/main/config', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.heroSlides = slides;
        await route.fulfill({ response, json: body });
    });
    await page.route('https://images.example.com/**', (route) => route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')
    }));

    await page.goto(storefrontPath);
    const hero = page.locator('#home .marketplace-hero-panel');
    await expect(hero).toHaveClass(/hero-slide-mode/);
    await expect(page.getByRole('heading', { name: 'Find something for every day.' })).toBeVisible();
    await expect(page.locator('#heroButton')).toHaveAttribute('href', '#shop');
    const image = page.locator('#heroSlideImage');
    await expect(image).toHaveAttribute('src', slides[0].image);
    await expect(image).toBeVisible();
    const imageBounds = await image.boundingBox();
    const artBounds = await page.locator('#home .marketplace-hero-art').boundingBox();
    const titleBounds = await page.locator('#heroTitle').boundingBox();
    expect(imageBounds.x).toBeGreaterThan(titleBounds.x);
    expect(imageBounds.x).toBeGreaterThanOrEqual(artBounds.x);
    expect(imageBounds.x + imageBounds.width).toBeLessThanOrEqual(artBounds.x + artBounds.width);
    await expect(page.getByRole('button', { name: 'Show hero slide 1' })).toHaveAttribute('aria-current', 'true');
    await page.getByRole('button', { name: 'Next hero slide' }).click();
    await expect(image).toHaveAttribute('src', slides[1].image);
    await expect(page.getByRole('button', { name: 'Show hero slide 2' })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('heading', { name: /First slide metadata|Second slide metadata/ })).toHaveCount(0);
    await page.locator('#heroButton').focus();
    await page.waitForTimeout(5200);
    await expect(image).toHaveAttribute('src', slides[0].image);
    await expect(page.getByRole('button', { name: 'Show hero slide 1' })).toHaveAttribute('aria-current', 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(image).toHaveAttribute('src', slides[0].mobileImage);
});

test('Stores page lists available shops with direct links', async ({ page }) => {
    const directoryResponse = await page.request.get('/api/v1/shops');
    expect(directoryResponse.status()).toBe(200);
    const shops = (await directoryResponse.json()).data;
    await page.goto('/shops');
    await expect(page.getByRole('heading', { name: 'Find your next favorite shop.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'All shops' })).toContainText(String(shops.length));
    const cards = page.locator('.shops-directory-results .marketplace-shop-card');
    await expect(cards).toHaveCount(shops.length);
    for (const shop of shops) {
        const card = cards.filter({ has: page.getByRole('heading', { name: shop.name, exact: true }) });
        await expect(card.getByRole('link', { name: 'Explore shop' }))
            .toHaveAttribute('href', `/shops/${encodeURIComponent(shop.slug)}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Top this week shows cross-shop rankings with shop-specific product links', async ({ page }) => {
    await page.route('**/api/v1/top-selling', (route) => route.fulfill({
        json: { data: [{
            id: 'weekly-product',
            name: 'Weekly favorite',
            description: 'Popular this week',
            price: 250,
            oldPrice: null,
            category: 'gadgets',
            shopSlug: 'other-shop',
            shopName: 'Other Shop',
            stockQuantity: 4,
            isAvailable: true
        }] }
    }));
    await page.goto('/top-selling');

    await expect(page.getByRole('heading', { name: 'Top selling this week', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Weekly favorite' })).toBeVisible();
    await expect(page.locator('.route-product-grid .market-product-card')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Other Shop' })).toHaveAttribute('href', '/shops/other-shop');
    await expect(page.getByRole('link', { name: 'View details for Weekly favorite', exact: true }))
        .toHaveAttribute('href', '/product/weekly-product?shop=other-shop');
    await expect(page.locator('[data-route-add]')).toBeEnabled();
    await expect(page.locator('[data-route-buy-now]')).toBeEnabled();
});

test('Deals lists discounted products from active shops marketplace-wide', async ({ page }) => {
    await page.route('**/api/v1/discounted-products', (route) => route.fulfill({
        json: { data: [{
            id: 'other-discount',
            name: 'Marketplace deal',
            description: 'Discounted in another shop',
            price: 150,
            oldPrice: 200,
            category: 'gadgets',
            shopSlug: 'other-shop',
            shopName: 'Other Shop',
            stockQuantity: 2,
            isAvailable: true
        }] }
    }));
    await page.goto('/deals?shop=main');

    await expect(page.getByRole('heading', { name: 'Deals and offers', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Discounted products' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Marketplace deal' })).toBeVisible();
    await expect(page.locator('.route-product-grid .market-product-card')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Other Shop' })).toHaveAttribute('href', '/shops/other-shop');
    await expect(page.getByRole('link', { name: 'View details for Marketplace deal', exact: true }))
        .toHaveAttribute('href', '/product/other-discount?shop=other-shop');
    await expect(page.locator('[data-route-add]')).toBeEnabled();
    await expect(page.locator('[data-route-buy-now]')).toBeEnabled();
});

test('shop profile presents storefront identity and navigable sections', async ({ page }) => {
    const response = await page.request.get('/api/v1/shops/main');
    expect(response.status()).toBe(200);
    const { data: shop } = await response.json();
    await page.route('**/api/v1/shops/main', async (route) => {
        const profileResponse = await route.fetch();
        const profile = await profileResponse.json();
        profile.data.topProducts = [{ productId: 'private-ranking', name: 'Private ranking', quantity: 99 }];
        await route.fulfill({ response: profileResponse, json: profile });
    });
    await page.goto('/shops/main');
    await expect(page.getByRole('heading', { name: shop.name, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Shop profile sections' })).toBeVisible();
    for (const [label, target] of [
        ['Products', '#shop-profile-products'],
        ['Categories', '#shop-profile-categories']
    ]) {
        await expect(page.getByRole('navigation', { name: 'Shop profile sections' }).getByRole('link', { name: new RegExp(label) }))
            .toHaveAttribute('href', target);
    }
    await expect(page.getByRole('navigation', { name: 'Shop profile sections' }).getByText('Top sellers'))
        .toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Top sellers' })).toHaveCount(0);
    await expect(page.getByText('Private ranking')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `Products from ${shop.name}` })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse products' }))
        .toHaveAttribute('href', '#shop-profile-products');

    for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
        expect(results.violations.map(({ id, impact, nodes }) => ({
            id,
            impact,
            targets: nodes.map(({ target }) => target)
        })), `Shop profile accessibility at ${width}px`).toEqual([]);
    }
});

test('product cards offer immediate checkout with a responsive purchase layout', async ({ page }) => {
    const response = await page.request.get('/api/v1/products?limit=100');
    expect(response.status()).toBe(200);
    const product = (await response.json()).data.find((item) =>
        item.isAvailable !== false && item.stockQuantity !== 0 && item.isAvailableForPurchase !== false
    );
    test.skip(!product?.shopSlug, 'Buy-now acceptance requires an available marketplace item with a shop.');

    await page.goto(`/shops/${encodeURIComponent(product.shopSlug)}`);
    const card = page.locator('.route-product-card').filter({
        has: page.getByRole('heading', { name: product.name, exact: true })
    });
    for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(card).toBeVisible();
        await expect(card.locator('.market-product-actions')).toBeVisible();
        await expect(card.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
        const cardWidth = await card.evaluate((element) => element.getBoundingClientRect().width);
        expect(cardWidth, `Single product card width at ${width}px`).toBeLessThanOrEqual(368);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const accessibility = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
        expect(accessibility.violations.map(({ id, impact, nodes }) => ({
            id,
            impact,
            targets: nodes.map(({ target }) => target)
        })), `Product card accessibility at ${width}px`).toEqual([]);
    }
    await card.getByRole('button', { name: 'Buy now' }).click();
    await expect(page.locator('#checkoutModal')).toBeVisible();
    await expect(page.locator('#coSubtotal')).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('storefront remains usable when external font and icon CDNs are unavailable', async ({ page }) => {
    const failedRequests = [];
    const pageErrors = [];
    page.on('requestfailed', (request) => failedRequests.push(new URL(request.url()).hostname));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route(
        /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//,
        (route) => route.abort()
    );

    const response = await page.goto(storefrontPath, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Shop products and deals | Main Shop | Shopademia');
    await expect(page.getByRole('heading', { name: 'Find something for every day.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shop Products' })).toBeVisible();
    await expect(page.locator('#productResultsStatus')).toContainText('Showing');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(failedRequests).toContain('cdnjs.cloudflare.com');
    expect(failedRequests).toContain('fonts.googleapis.com');
    expect(pageErrors).toEqual([]);
});

test('home product grid adapts its columns to available products and viewport width', async ({ page }) => {
    const products = Array.from({ length: 3 }, (_value, index) => ({
        id: `layout-product-${index + 1}`,
        name: `Layout product ${index + 1}`,
        description: 'A responsive grid test product.',
        price: 250,
        oldPrice: null,
        category: 'gadgets',
        stockQuantity: 4,
        isAvailable: true,
        shopId: '00000000-0000-4000-8000-000000000011',
        shopAdvanceCharge: 35,
        shopSlug: 'main',
        shopName: 'Main Shop'
    }));
    await page.route((url) => new URL(url).pathname === '/api/v1/products', (route) =>
        route.fulfill({ json: { data: products } })
    );
    await page.goto(storefrontPath);
    const grid = page.locator('#featuredProductGrid');
    await expect(grid.locator('.market-product-card')).toHaveCount(products.length);
    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopLayout = await grid.evaluate((element) => ({
        columns: getComputedStyle(element).gridTemplateColumns.split(' ')
            .filter((width) => Number.parseFloat(width) > 0).length,
        cardWidths: [...element.querySelectorAll('.market-product-card')]
            .map((card) => card.getBoundingClientRect().width)
    }));
    expect(desktopLayout.columns).toBe(products.length);
    expect(desktopLayout.cardWidths.every((width) => width <= 288)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileColumns = await grid.evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length
    );
    expect(mobileColumns).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('shop product API is public, CORS-readable, and returns only managed listings', async ({ page }) => {
    const shopsResponse = await page.request.get('/api/v1/shops');
    expect(shopsResponse.status()).toBe(200);
    const shops = (await shopsResponse.json()).data;
    expect(shops.some(({ slug }) => slug === 'main')).toBe(true);

    const productsResponse = await page.request.get('/api/v1/public/shops/main/products', {
        headers: { Origin: 'https://external-shop.example' }
    });
    expect(productsResponse.status()).toBe(200);
    expect(productsResponse.headers()['access-control-allow-origin']).toBe('*');
    expect(productsResponse.headers()['cross-origin-resource-policy']).toBe('cross-origin');
    const result = await productsResponse.json();
    expect(result.shop.slug).toBe('main');
    expect(result.data.every(({ id }) => /^admin-[0-9a-f-]{36}$/i.test(id))).toBe(true);
    expect(result.data.some((product) => 'phone' in product || 'address' in product)).toBe(false);
    expect(result.pagination).toMatchObject({ limit: 50, offset: 0 });

    const crossOriginServer = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>External integration check</title>');
    });
    await new Promise((resolve, reject) => {
        crossOriginServer.once('error', reject);
        crossOriginServer.listen(0, '127.0.0.1', resolve);
    });
    try {
        const address = crossOriginServer.address();
        await page.goto(`http://127.0.0.1:${address.port}`);
        const browserFetch = await page.evaluate(async (url) => {
            const response = await fetch(url);
            return { status: response.status, body: await response.json() };
        }, new URL('/api/v1/public/shops/main/products', process.env.PLAYWRIGHT_BASE_URL).href);
        expect(browserFetch.status).toBe(200);
        expect(browserFetch.body.shop.slug).toBe('main');
    } finally {
        await new Promise((resolve, reject) => crossOriginServer.close((error) => error ? reject(error) : resolve()));
    }
});

test('public routes, error page, and mobile layout work', async ({ page }) => {
    await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const data = path === '/api/v1/shops/main/config'
            ? { shopId: 1, slug: 'main', name: 'Main Shop', heroSlides: [] }
            : [];
        await route.fulfill({
            json: path === '/api/v1/shops/main/config'
                ? { data, delivery: { advanceCharge: 0 } }
                : { data }
        });
    });
    for (const [path, heading] of [
        ['/privacy', 'Privacy policy'],
        ['/terms', 'Terms & conditions'],
        ['/about', 'Shopping with main shop'],
        ['/shops', 'Find your next favorite shop'],
        ['/deals', 'Deals and offers']
    ]) {
        const response = await page.goto(`${path}?shop=main`);
        expect(response?.status(), path).toBe(200);
        await expect(page.getByRole('heading', { name: new RegExp(heading, 'i') }).first()).toBeVisible();
    }
    await page.goto('/about?shop=main');
    await expect(page.getByRole('heading', { name: 'Frequently asked questions' })).toBeVisible();
    await expect(page.getByText('Is my order confirmed when I submit it?')).toBeVisible();
    await page.locator('.route-faq details').nth(2).locator('summary').click();
    await expect(page.locator('.route-faq a')).toHaveAttribute('href', '/find-order?shop=main');

    const missingResponse = await page.goto('/a-page-that-does-not-exist');
    expect(missingResponse?.status()).toBe(404);
    const missingBody = await missingResponse?.text() || '';
    expect(missingBody).not.toMatch(/stack|DATABASE_URL|JWT_SECRET|C:\\\\/i);
    if (missingResponse?.headers()['content-type']?.includes('text/html')) {
        await expect(page.getByRole('heading', { name: /took a wrong turn/i })).toBeVisible();
    } else {
        expect(JSON.parse(missingBody)).toEqual({ error: 'Route unavailable in read-only preview mode.' });
    }

    for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1365, height: 900 }
    ]) {
        await page.setViewportSize(viewport);
        await page.goto(storefrontPath);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
            .toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(storefrontPath);
    await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
    await expect(page.getByText('Shopademia', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Search products' }).click();
    await page.locator('#mobileSearchInput').fill('no-such-product');
    await page.locator('#mobileSearchInput').press('Enter');
    await expect(page.locator('#mobileSearchPanel')).toBeHidden();
    await expect(page.locator('#searchInput')).toHaveValue('no-such-product');
    await expect(page.locator('#productResultsStatus')).toBeFocused();
    await expect(page.locator('#productResultsStatus')).toContainText('matching');
    await expect.poll(() => page.evaluate(() =>
        Math.round(document.querySelector('#shop h2').getBoundingClientRect().top
            - document.querySelector('.marketplace-header').getBoundingClientRect().bottom)
    )).toBeGreaterThanOrEqual(0);
});

test('public storefront keyboard navigation keeps visible focus', async ({ page }) => {
    await page.goto(storefrontPath);
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    const accessibleName = await focused.evaluate((element) =>
        element.getAttribute('aria-label')
        || element.innerText
        || element.getAttribute('title')
        || element.getAttribute('value')
        || ''
    );
    expect(accessibleName.trim()).not.toBe('');
});

test('product detail route and metadata render for an available catalog item', async ({ page }) => {
    const catalogResponse = await page.request.get('/api/v1/products?limit=100');
    expect(catalogResponse.status()).toBe(200);
    const catalog = await catalogResponse.json();
    const product = catalog.data.find((item) => item.shopSlug
        && item.isAvailable !== false && item.stockQuantity !== 0 && item.isAvailableForPurchase !== false);
    test.skip(!product, 'Product detail acceptance requires an available marketplace item with a shop.');
    test.skip(
        product.isAvailable === false || product.stockQuantity === 0 || product.isAvailableForPurchase === false,
        'Buy-now acceptance requires an available catalog item.'
    );

    const galleryImages = [
        '/uploads/11111111-1111-4111-8111-111111111111.jpg',
        '/uploads/22222222-2222-4222-8222-222222222222.jpg'
    ];
    await page.route(`**/api/v1/shops/${encodeURIComponent(product.shopSlug)}/products**`, (route) => route.fulfill({
        json: { ...catalog, data: [{ ...product, images: galleryImages }] }
    }));
    await page.route('**/uploads/11111111-1111-4111-8111-111111111111.jpg', (route) => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    }));
    await page.route('**/uploads/22222222-2222-4222-8222-222222222222.jpg', (route) => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    }));

    const productResponse = await page.goto(`/product/${encodeURIComponent(product.id)}?shop=${encodeURIComponent(product.shopSlug)}`);
    expect(productResponse?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How ordering works' })).toBeVisible();
    const wishlistButton = page.getByRole('button', { name: 'Save to wishlist' });
    await expect(wishlistButton).toHaveAttribute('aria-pressed', 'false');
    await wishlistButton.click();
    await expect(page.getByRole('button', { name: 'Remove from wishlist' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Remove from wishlist' }).click();
    await expect(page.getByRole('button', { name: 'Save to wishlist' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveTitle(`${product.seoTitle?.trim() || product.name} | ${product.shopName} | Shopademia`);
    const canonicalProductUrl = new URL(`/product/${encodeURIComponent(product.id)}`, expectedSiteOrigin);
    if (product.shopSlug !== 'main') canonicalProductUrl.searchParams.set('shop', product.shopSlug);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonicalProductUrl.toString());
    const structuredData = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    expect(structuredData['@graph'].some(({ '@type': type }) => type === 'Product')).toBe(true);
    expect(structuredData['@graph'].some(({ '@type': type }) => type === 'BreadcrumbList')).toBe(true);
    expect(structuredData['@graph'].some(({ '@type': type }) => type === 'WebSite')).toBe(true);
    expect(structuredData['@graph'].some(({ aggregateRating }) => aggregateRating)).toBe(false);
    const configuredMetaDescription = product.metaDescription?.trim();
    const productDescription = product.description?.trim().replace(/\s+/g, ' ');
    const expectedMetaDescription = configuredMetaDescription || (productDescription
        ? (productDescription.length > 160 ? `${productDescription.slice(0, 157).trimEnd()}…` : productDescription)
        : `Explore ${product.name} from ${product.shopName} on Shopademia.`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', expectedMetaDescription);

    const gallery = page.getByRole('group', { name: 'Product images' });
    const thumbnails = gallery.locator('[data-product-gallery-image]');
    await expect(thumbnails).toHaveCount(2);
    await thumbnails.nth(1).click();
    await expect(page.locator('[data-product-gallery-main]')).toHaveAttribute('src', galleryImages[1]);
    await expect(thumbnails.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(thumbnails.nth(1)).toHaveAttribute('aria-pressed', 'true');

    for (const width of [320, 390, 600, 704, 705, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.locator('.route-product-detail').evaluate((detail) => ({
            columns: getComputedStyle(detail).gridTemplateColumns.trim().split(/\s+/).length,
            detailWidth: detail.clientWidth,
            detailScrollWidth: detail.scrollWidth,
            copyWidth: detail.querySelector('.route-detail-copy').getBoundingClientRect().width,
            buttonWidth: detail.querySelector('.route-add-button').getBoundingClientRect().width
        }));
        expect(layout.columns, `Product layout at ${width}px`).toBe(width <= 704 ? 1 : 2);
        expect(layout.detailScrollWidth, `Product content overflow at ${width}px`).toBeLessThanOrEqual(layout.detailWidth);
        expect(layout.copyWidth, `Product information column at ${width}px`).toBeGreaterThan(0);
        expect(layout.buttonWidth, `Purchase button at ${width}px`).toBeLessThanOrEqual(layout.copyWidth);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
            .toBe(true);

        if (width === 390 || width === 1440) {
            const results = await new AxeBuilder({ page })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
                .analyze();
            expect(results.violations.map(({ id, impact, nodes }) => ({
                id,
                impact,
                targets: nodes.map(({ target }) => target)
            })), `Product detail accessibility at ${width}px`).toEqual([]);
        }
    }

    await page.getByRole('button', { name: 'Buy now' }).click();
    await expect(page.locator('#checkoutModal')).toBeVisible();
    await expect(page.locator('#coSubtotal')).not.toBeEmpty();
});

test('category product image link has an accessible name and opens product details', async ({ page }) => {
    const shopsResponse = await page.request.get('/api/v1/shops');
    expect(shopsResponse.status()).toBe(200);
    const { data: shops } = await shopsResponse.json();
    let product;
    let productShop;
    for (const shop of shops) {
        const response = await page.request.get(`/api/v1/shops/${encodeURIComponent(shop.slug)}/products`);
        if (response.status() !== 200) continue;
        const { data } = await response.json();
        if (!data.length) continue;
        product = { ...data[0], shopSlug: shop.slug, shopName: shop.name };
        productShop = shop;
        break;
    }
    test.skip(!product, 'Category product-link accessibility requires at least one active shop product.');
    const productResponse = { data: [product] };
    await page.route((url) => new URL(url).pathname === '/api/v1/products', (route) =>
        route.fulfill({ json: productResponse })
    );

    await page.goto(`/category/${encodeURIComponent(product.category)}?shop=main`);
    const productLink = page.getByRole('link', { name: `View details for ${product.name}`, exact: true });
    await expect(productLink).toBeVisible();
    await expect(productLink).toHaveAttribute(
        'href',
        `/product/${encodeURIComponent(product.id)}?shop=${encodeURIComponent(productShop.slug)}`
    );
    await productLink.click();
    await expect(page).toHaveURL(new RegExp(`/product/${encodeURIComponent(product.id)}\\?shop=${encodeURIComponent(productShop.slug)}$`));
    await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
});

test('homepage internal links resolve and Stores network errors are visible', async ({ page }) => {
    await page.route('**/api/v1/shops/main/config', (route) => route.fulfill({
        json: {
            data: { shopId: '00000000-0000-4000-8000-000000000001', slug: 'main', name: 'Main Shop', heroSlides: [] },
            delivery: { advanceCharge: 0 }
        }
    }));
    await page.route('**/api/v1/storefront-announcement', (route) => route.fulfill({
        json: { data: { text: 'Discover products from independent shops' } }
    }));
    await page.route('**/api/v1/categories', (route) => route.fulfill({
        json: { data: [{ id: 'gadgets', name: 'Electronics', icon: 'fa-laptop' }] }
    }));
    await page.route((url) => new URL(url).pathname.startsWith('/api/v1/products'), (route) => {
        const isHeroOffer = new URL(route.request().url()).pathname.endsWith('/hero-offer');
        return route.fulfill({ json: { data: isHeroOffer ? null : [] } });
    });
    await page.route('**/api/v1/top-selling', (route) => route.fulfill({
        json: { data: [] }
    }));
    await page.goto(storefrontPath);
    const baseUrl = new URL(process.env.PLAYWRIGHT_BASE_URL);
    const navigation = await page.locator('.marketplace-category-nav [data-nav-route]').evaluateAll((links) =>
        links.map((link) => ({ route: link.dataset.navRoute, pathname: new URL(link.href).pathname }))
    );
    expect(navigation.map(({ route }) => route)).toEqual([
        'home', 'top-selling', 'categories', 'deals', 'stores', 'about'
    ]);
    expect(new Set(navigation.map(({ pathname }) => pathname)).size).toBe(navigation.length);
    expect(navigation.find(({ route }) => route === 'top-selling').pathname).toBe('/top-selling');
    const mobileNavigation = await page.locator('#mobileNavigationPanel [data-nav-route]')
        .evaluateAll((links) => links.map((link) => ({
            route: link.dataset.navRoute,
            pathname: new URL(link.href).pathname
        })));
    expect(mobileNavigation.slice(0, navigation.length)).toEqual(navigation);

    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
    const internalUrls = [...new Set(hrefs.filter((href) => {
        const url = new URL(href);
        return url.origin === baseUrl.origin && url.pathname !== '/' && url.pathname !== '/find-order';
    }))];
    const failures = [];
    for (const url of internalUrls) {
        const response = await page.request.get(url);
        if (response.status() >= 400) failures.push(`${response.status()} ${url}`);
    }
    expect(failures).toEqual([]);

    await page.locator('.marketplace-category-nav [data-nav-route="top-selling"]').click();
    await expect(page).toHaveURL(/\/top-selling$/);
    await expect(page.getByRole('heading', { name: 'Top selling this week', exact: true })).toBeVisible();
    await expect(page.locator('.marketplace-category-nav [data-nav-route="top-selling"]'))
        .toHaveAttribute('aria-current', 'page');
    await page.locator('.marketplace-category-nav [data-nav-route="categories"]').click();
    await expect(page).toHaveURL(/\/category\/[a-z0-9-]+\?shop=main$/);
    await expect(page.locator('.marketplace-category-nav [data-nav-route="categories"]'))
        .toHaveAttribute('aria-current', 'page');

    await page.route('**/api/v1/shops', (route) => route.abort());
    await page.goto('/shops?shop=main');
    await expect(page.getByRole('alert')).toContainText('We couldn’t load this page');
    const brandLink = page.locator('.marketplace-primary-nav > a').first();
    await expect(brandLink).toHaveAttribute('href', '/');
    await brandLink.click();
    await expect(page).toHaveURL(`${baseUrl.origin}/`);
});

test('homepage, Stores, and policy pages pass automated WCAG 2.1 AA checks', async ({ page }) => {
    for (const path of [storefrontPath, '/shops', '/privacy', '/terms']) {
        await page.goto(path);
        const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
        const summary = results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            count: violation.nodes.length,
            examples: violation.nodes.slice(0, 12).map((node) => ({
                target: node.target,
                issue: node.any.map(({ message, data }) => ({
                    message,
                    contrastRatio: data?.contrastRatio,
                    foreground: data?.fgColor,
                    background: data?.bgColor
                }))
            }))
        }));
        console.log(`Accessibility results for ${path}: ${JSON.stringify(summary)}`);
        expect(summary, `${path} has WCAG accessibility violations`).toEqual([]);
    }
});
