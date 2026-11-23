<?php
$_SERVER['HTTP_HOST'] = 'wordpress';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$error = activate_plugin('woocommerce/woocommerce.php');
if (is_wp_error($error)) {
    throw new RuntimeException($error->get_error_message());
}
if (getenv("WC_SEED") !== "yes") {
    // Load the newly activated plugin normally in a fresh PHP process before seeding.
    exit(0);
}
WC_Install::install();
WC_Install::create_pages();
$cart_page = wc_get_page_id('cart');
if ($cart_page <= 0) {
    throw new RuntimeException('Missing cart page');
}
wp_update_post(['ID' => $cart_page, 'post_name' => 'qa-cart', 'post_content' => '[woocommerce_cart]']);
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_currency', 'JPY');
update_option('woocommerce_price_num_decimals', '0');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_enable_coupons', 'yes');
update_option('woocommerce_bacs_settings', ['enabled' => 'yes', 'title' => 'Test bank transfer']);
$ids = [];
foreach ([['proof-paper', '校正用紙', 1200], ['envelope', '封筒', 300]] as [$sku, $name, $price]) {
    $product = new WC_Product_Simple();
    $product->set_name($name);
    $product->set_sku($sku);
    $product->set_regular_price((string)$price);
    $product->set_virtual(true);
    $product->set_status('publish');
    $ids[] = $product->save();
}
$coupon = new WC_Coupon();
$coupon->set_code('proof-only');
$coupon->set_discount_type('fixed_product');
$coupon->set_amount(200);
$coupon->set_product_ids([$ids[0]]);
$coupon->save();
