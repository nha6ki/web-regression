<?php
// Install in the disposable container using the same URL the browser will use.
define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST'] = 'wordpress';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
$password = getenv('WORDPRESS_DB_PASSWORD');
if (!is_blog_installed()) {
    wp_install('Regression site', 'qaadmin', 'admin@example.test', false, '', $password);
}
if (!username_exists('qaeditor')) {
    $id = wp_insert_user([
        'user_login' => 'qaeditor', 'user_pass' => $password,
        'user_email' => 'editor@example.test', 'role' => 'editor',
    ]);
    if (is_wp_error($id)) {
        file_put_contents('php://stderr', 'Cannot create editor: ' . $id->get_error_code() . PHP_EOL);
        exit(1);
    }
}
