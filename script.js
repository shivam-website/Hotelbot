const venom = require('venom-bot');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { app, setClient } = require('./server');

// Hotel Configuration
const hotelConfig = {
  name: "Raj Darbar Resort",
  adminNumber: '9779819809195@c.us',
  receptionExtension: "22",
  databaseFile: path.join(__dirname, 'orders.json'),
  menu: {
    breakfast: [
      "Continental Breakfast - ₹500",
      "Full English Breakfast - ₹750",
      "Pancakes with Maple Syrup - ₹450"
    ],
    lunch: [
      "Grilled Chicken Sandwich - ₹650",
      "Margherita Pizza - ₹800",
      "Vegetable Pasta - ₹550"
    ],
    dinner: [
      "Grilled Salmon - ₹1200",
      "Beef Steak - ₹1500",
      "Vegetable Curry - ₹600"
    ],
    roomService: [
      "Club Sandwich - ₹450",
      "Chicken Burger - ₹550",
      "Chocolate Lava Cake - ₹350"
    ]
  },
  hours: {
    breakfast: "7:00 AM - 10:30 AM",
    lunch: "12:00 PM - 3:00 PM",
    dinner: "6:30 PM - 11:00 PM",
    roomService: "24/7"
  },
  checkInTime: "2:00 PM",
  checkOutTime: "11:00 AM"
};

const genAI = new GoogleGenerativeAI("AIzaSyASc5JDTn-7mD6_CUefisGlkP9aRUHETUM");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

if (!fs.existsSync(hotelConfig.databaseFile)) {
  fs.writeFileSync(hotelConfig.databaseFile, '[]');
}

const userStates = new Map();

venom.create({ session: 'hotel-bot', headless: true }).then(client => {
  console.log("✅ WhatsApp Bot Ready");
  setClient(client);

  app.listen(3000, () => {
    console.log('🌐 Dashboard running at http://localhost:3000/admin.html');
  });

  client.onMessage(async (message) => {
    if (!message.body || message.isGroupMsg) return;

    const from = message.from;
    const rawMsg = message.body.trim();
    const isNepali = rawMsg.startsWith('/ne ');
    const userMsg = isNepali ? rawMsg.replace('/ne ', '') : rawMsg;

    // Handle rating button responses
    if (message.type === 'buttons_response' || message.type === 'button') {
      const ratingIds = ['star_1', 'star_2', 'star_3', 'star_4', 'star_5'];
      const selectedId = message.selectedButtonId || message.selectedButtonId;
      if (ratingIds.includes(selectedId)) {
        const rating = selectedId.replace('star_', '');
        await client.sendText(from, `Thank you for rating us ⭐${rating}!`);
        return;
      }
    }

    if (!userStates.has(from)) {
      userStates.set(from, { lang: isNepali ? 'ne' : 'en', chatHistory: [] });
    } else if (isNepali) {
      userStates.get(from).lang = 'ne';
    }

    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from);
      await client.sendText(from, "🔄 Chat has been reset. How may I assist you today?");
      return;
    }

    if (from === hotelConfig.adminNumber && await handleManagerCommands(client, userMsg)) return;

    if (await handleOngoingConversation(client, from, userMsg)) return;

    const aiResponse = await getContextualAIResponse(client, from, userMsg);
    await client.sendText(from, aiResponse);
  });

}).catch(console.error);

async function getContextualAIResponse(client, from, prompt) {
  try {
    const state = userStates.get(from) || {};

    const context = {
      hotel: hotelConfig.name,
      checkIn: hotelConfig.checkInTime,
      checkOut: hotelConfig.checkOutTime,
      menu: JSON.stringify(hotelConfig.menu),
      services: ["room service", "housekeeping", "restaurant"],
      currentState: state.step || "new_conversation",
      previousMessages: state.chatHistory || [],
      language: state.lang || 'en'
    };

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are the concierge at ${hotelConfig.name}. Respond in ${context.language === 'ne' ? 'Nepali' : 'English'}.

CONTEXT:
${JSON.stringify(context, null, 2)}

GUEST MESSAGE: "${prompt}"

INSTRUCTIONS:
1. Assist with food orders, check-in/out times, hotel services, and requests like towels.
2. Detect food intent, room mentions, quantities (e.g. 2 burgers), and ensure polite and helpful tone.`
            }
          ]
        }
      ]
    });

    const responseText = (await result.response).text();
    await handleAIResponseActions(client, from, prompt, responseText);

    if (!userStates.has(from)) userStates.set(from, { chatHistory: [] });
    userStates.get(from).chatHistory.push({ role: "guest", content: prompt }, { role: "bot", content: responseText });

    return responseText;
  } catch (err) {
    console.error("❌ AI Error:", err);
    return "I'm having trouble understanding. Could you please rephrase that?";
  }
}

async function handleAIResponseActions(client, from, prompt, responseText) {
  const lowerPrompt = prompt.toLowerCase();
  const lowerResponse = responseText.toLowerCase();

  if (lowerPrompt.includes("towel") || lowerPrompt.includes("blanket") || lowerPrompt.includes("water")) {
    await client.sendText(from, "✅ Your request has been noted. A staff member will attend to your room shortly.");
  }

  if (lowerResponse.includes('order') || lowerPrompt.includes('order') || lowerPrompt.includes('want to eat') || lowerPrompt.includes('hungry')) {
    await initiateOrderProcess(client, from);
  }
  if ((lowerPrompt.includes('menu') || lowerPrompt.includes('show me food') || lowerPrompt.includes('what can i eat')) && !lowerResponse.includes('continental breakfast')) {
    await sendFullMenu(client, from);
  }
}

async function initiateOrderProcess(client, from) {
  if (userStates.has(from) && userStates.get(from).step) return;
  await client.sendText(from, "May I have your room number to start your order?");
  userStates.set(from, {
    ...userStates.get(from),
    step: 'awaiting_room'
  });
}

async function handleOngoingConversation(client, from, userMsg) {
  if (!userStates.has(from)) return false;
  const state = userStates.get(from);

  if (state.step === 'awaiting_room') {
    const match = userMsg.match(/room\s*(\d{3,4})/i) || userMsg.match(/(\d{3,4})/);
    const roomNumber = match ? match[1] : null;
    if (!roomNumber) {
      await client.sendText(from, "Please enter a valid 3-4 digit room number:");
      return true;
    }
    userStates.set(from, { ...state, step: 'awaiting_order', room: roomNumber });
    await client.sendText(from, `Thank you! What would you like to order from our menu?`);
    return true;
  }

  if (state.step === 'awaiting_order') {
    const { found, unavailable } = findOrderItems(userMsg);
    if (!found.length) {
      await client.sendText(from, "I couldn't find any valid items. Would you like to see our menu again?");
      await sendFullMenu(client, from);
      return true;
    }
    userStates.set(from, {
      ...state,
      step: 'awaiting_confirmation',
      items: found
    });

    let response = `Your order:\nRoom ${state.room}\nItems:\n${found.join('\n')}`;
    if (unavailable.length) {
      response += `\n\n⚠️ These items are not available: ${unavailable.join(', ')}`;
    }
    response += `\n\nDoes this look correct? (Reply "yes" to confirm or "no" to change)`;

    await client.sendText(from, response);
    return true;
  }

  if (state.step === 'awaiting_confirmation') {
    if (userMsg.toLowerCase().includes('yes')) {
      const orderId = Date.now();
      const newOrder = {
        id: orderId,
        room: state.room,
        items: state.items,
        guestNumber: from,
        status: "Pending",
        timestamp: new Date().toISOString()
      };

      const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
      orders.push(newOrder);
      fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

      await notifyManager(client, `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${state.items.join('\n')}`);
      await client.sendText(from, `Your order #${orderId} has been placed! It will arrive in 30-45 minutes.`);

      await client.sendButtons(
        from,
        '🙏 We’d love your feedback! Please rate us:',
        [
          { buttonText: { displayText: '⭐ 1' }, id: 'star_1' },
          { buttonText: { displayText: '⭐ 2' }, id: 'star_2' },
          { buttonText: { displayText: '⭐ 3' }, id: 'star_3' },
          { buttonText: { displayText: '⭐ 4' }, id: 'star_4' },
          { buttonText: { displayText: '⭐ 5' }, id: 'star_5' }
        ],
        'Rate Us',  // must be non-empty string
        'Tap one below to rate our service.'
      );
      
      

      userStates.delete(from);
      return true;
    } else if (userMsg.toLowerCase().includes('no')) {
      userStates.set(from, { ...state, step: 'awaiting_order' });
      await client.sendText(from, "Let's try again. What would you like to order?");
      return true;
    }
  }

  return false;
}

async function handleManagerCommands(client, message) {
  const confirmMatch = message.match(/^confirm\s+#(\d+)$/i);
  const doneMatch = message.match(/^done\s+#(\d+)$/i);

  if (confirmMatch) return await updateOrderStatus(client, confirmMatch[1], "Confirmed");
  if (doneMatch) return await updateOrderStatus(client, doneMatch[1], "Completed");
  return false;
}

async function updateOrderStatus(client, orderId, newStatus) {
  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderIndex = orders.findIndex(o => o.id.toString() === orderId);
  if (orderIndex === -1) {
    await client.sendText(hotelConfig.adminNumber, `Order #${orderId} not found.`);
    return true;
  }

  const order = orders[orderIndex];
  orders[orderIndex].status = newStatus;
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  await client.sendText(hotelConfig.adminNumber, `Order #${orderId} marked as ${newStatus}.`);
  await client.sendText(order.guestNumber, `Your order #${orderId} has been ${newStatus.toLowerCase()}.`);

  return true;
}

function findOrderItems(msg) {
  const found = [];
  const unavailable = [];
  const lowerMsg = msg.toLowerCase();

  for (const category in hotelConfig.menu) {
    for (const item of hotelConfig.menu[category]) {
      const [name, priceStr] = item.split(' - ₹');
      const nameLower = name.toLowerCase();

      // Match quantity + item or just item
      const regex = new RegExp(`(\\d+)?\\s*${nameLower}`, 'i');
      const match = lowerMsg.match(regex);

      let quantity = 0;
      if (match) {
        quantity = match[1] ? parseInt(match[1]) : 1;
      }

      if (quantity > 0) {
        const price = parseInt(priceStr);
        const total = price * quantity;
        found.push(`${name} x${quantity} - ₹${total}`);
      }
    }
  }

  // Remove unavailable words check to avoid false positives

  return { found, unavailable };
}

async function notifyManager(client, text) {
  try {
    await client.sendText(hotelConfig.adminNumber, text);
  } catch (err) {
    console.error("Failed to notify manager:", err.message);
  }
}

async function sendFullMenu(client, number) {
  let text = `📋 Our Menu:\n\n`;
  for (const category in hotelConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${hotelConfig.hours[category]}):\n`;
    text += hotelConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "\nYou can say things like 'I'd like to order 2 pancakes' or 'Can I get a towel + chicken sandwich?'";
  await client.sendText(number, text);
}
