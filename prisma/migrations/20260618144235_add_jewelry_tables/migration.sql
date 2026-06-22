-- CreateTable
CREATE TABLE `StoreConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `gold_rate_9k` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `gold_rate_14k` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `gold_rate_18k` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `gold_rate_22k` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `silver_rate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `making_charge_gold` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `making_charge_silver` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `gst_percentage` DECIMAL(5, 2) NOT NULL DEFAULT 3.00,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StoreConfig_shop_key`(`shop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiamondRate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `color` VARCHAR(10) NOT NULL,
    `clarity` VARCHAR(15) NOT NULL,
    `size_min` DECIMAL(5, 3) NOT NULL,
    `size_max` DECIMAL(5, 3) NOT NULL,
    `price_per_carat` DECIMAL(12, 2) NOT NULL,

    INDEX `DiamondRate_shop_color_clarity_idx`(`shop`, `color`, `clarity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariantWeightConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(100) NOT NULL,
    `variant_id` VARCHAR(255) NOT NULL,
    `metal_type` VARCHAR(20) NOT NULL DEFAULT 'gold',
    `purity` VARCHAR(10) NOT NULL,
    `metal_weight` DECIMAL(8, 3) NOT NULL,
    `diamond_color` VARCHAR(10) NULL,
    `diamond_clarity` VARCHAR(15) NULL,
    `diamond_carat` DECIMAL(6, 3) NOT NULL DEFAULT 0.000,

    UNIQUE INDEX `VariantWeightConfig_variant_id_key`(`variant_id`),
    INDEX `VariantWeightConfig_sku_purity_idx`(`sku`, `purity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
