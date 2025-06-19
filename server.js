const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5000;
const DB_FILE = path.join(__dirname, 'orders.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let venomClient = null;

/**
 * Set venom client instance for WhatsApp notifications
 * @param {*} client - venom client instance
 */
function setClient(client) {
  venomClient = client;
}

/**
 * Load orders from JSON file
 * @returns {Array} list of orders
 */
function loadOrders() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '[]', 'utf-8');
  }
  try {
    const rawData = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(rawData);
  } catch (err) {
    console.error('Failed to parse orders.json:', err);
    return [];
  }
}

/**
 * Save orders to JSON file
 * @param {Array} orders
 */
function saveOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

// Create new order
app.post('/api/orders', async (req, res) => {
  const { room, items, guestNumber } = req.body;

  if (!room || typeof room !== 'string' || !room.trim()) {
    return res.status(400).json({ error: 'Room is required and must be a non-empty string.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items must be a non-empty array.' });
  }

  const newOrder = {
    id: Date.now(),
    room: room.trim(),
    items: items.map(i => i.trim()),
    guestNumber: typeof guestNumber === 'string' && guestNumber.trim() ? guestNumber.trim() : null,
    status: 'Pending',
    timestamp: Date.now(),
  };

  const orders = loadOrders();
  orders.push(newOrder);
  saveOrders(orders);

  // Notify manager/admin on WhatsApp
  if (venomClient) {
    const summary = `📢 *NEW ORDER*\n🆔 #${newOrder.id}\n🏨 Room: ${newOrder.room}\n🍽 Items:\n${newOrder.items.join('\n')}`;
    try {
      await venomClient.sendText('9779819809195@c.us', summary); // admin number
      console.log(`📤 Notified manager of new order #${newOrder.id}`);
    } catch (err) {
      console.error('⚠️ Failed to notify manager:', err.message);
    }
  }

  res.status(201).json({ success: true, order: newOrder });
});

// Get all orders
app.get('/api/orders', (req, res) => {
  const orders = loadOrders().map(order => {
    if (!order.timestamp) order.timestamp = Date.now();
    return order;
  });
  saveOrders(orders);
  res.json(orders);
});

// Update order status (Pending, Confirmed, Done, Rejected)
app.post('/api/orders/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;

  const validStatuses = ['Pending', 'Confirmed', 'Done', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  const orders = loadOrders();
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[index].status = status;
  saveOrders(orders);

  const order = orders[index];
  const guestNumber = order.guestNumber;

  if (venomClient && guestNumber && guestNumber.endsWith('@c.us')) {
    let msg = '';
    switch (status) {
      case 'Confirmed':
        msg = `✅ Your order #${id} has been *confirmed* and is now being prepared. Please wait.`;
        break;
      case 'Done':
        msg = `✅ Your order #${id} has been *completed*. Thank you for staying with us!`;
        break;
      case 'Rejected':
        msg = `❌ Your order #${id} was *rejected* by the manager. Please contact reception for help.`;
        break;
      default:
        msg = '';
    }
    if (msg) {
      try {
        await venomClient.sendText(guestNumber, msg);
        console.log(`📩 WhatsApp update sent to guest ${guestNumber} → ${status}`);
      } catch (err) {
        console.error('⚠️ Failed to notify guest via WhatsApp:', err.message);
      }
    }
  }

  res.json({ success: true });
});

// Delete an order
app.delete('/api/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const orders = loadOrders();

  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order not found.' });

  orders.splice(index, 1);
  saveOrders(orders);

  res.json({ success: true, message: `Order ${id} deleted.` });
});

// Delete all orders with status 'Done'
app.delete('/api/orders/done', (req, res) => {
  let orders = loadOrders();
  const beforeCount = orders.length;
  orders = orders.filter(order => order.status !== 'Done');
  const removedCount = beforeCount - orders.length;
  saveOrders(orders);

  res.json({ success: true, message: `Removed ${removedCount} done orders.` });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app and client setter
module.exports = { app, setClient };
