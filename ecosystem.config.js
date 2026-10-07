// pm2 settings for a hosted copy: `pm2 start ecosystem.config.js` (see DEPLOYMENT.md).
// One entry runs every store (stores are added from the Admin page).
module.exports = {
  apps: [
    {
      name: 'stock-and-ordering',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
        TRUST_PROXY: 'loopback',
        INVENTORY_DB: '/opt/inventory/inventory.db', // hub.db and stores/ live beside it
        STORE_NAME: 'Northgate',
      },
    },
  ],
};
