const venom = require('venom-bot');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { app, setClient } = require('./server');

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Sitasharan Resort",
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

// Initialize Google Generative AI with your API key
const genAI = new GoogleGenerativeAI("AIzaSyASc5JDTn-7mD6_CUefisGlkP9aRUHETUM"); // Use env variable in prod
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Ensure orders.json database file exists
if (!fs.existsSync(hotelConfig.databaseFile)) {
  fs.writeFileSync(hotelConfig.databaseFile, '[]');
}

// Map to store user conversation states
const userStates = new Map();

// Prepare a flat list of all valid menu item names (lowercase)
const allMenuItems = Object.values(hotelConfig.menu)
  .flat()
  .map(item => item.split(' - ')[0].toLowerCase());

// Helper function to filter only valid menu items
function filterValidItems(items) {
  return items.filter(item => {
    const lowered = item.toLowerCase();
    // Accept if item contains any valid menu item substring
    return allMenuItems.some(menuItem => lowered.includes(menuItem));
  });
}

venom
  .create({
    session: 'hotel-bot',
    headless: true,
    useChrome: false,
    sessionFolder: './tokens',
    multidevice: true,
    cacheEnabled: false,
    disableSpins: true,
    killProcessOnBrowserClose: true,
    puppeteerOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--enable-features=NetworkService,NetworkServiceInProcess'
      ],
      executablePath:
        process.env.CHROME_BIN ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/usr/bin/google-chrome'
    }
  })

.then(client => {
  console.log("✅ WhatsApp Bot Ready");
  setClient(client);

  app.listen(3000, () => {
    console.log('🌐 Dashboard running at http://localhost:3000/admin.html');
  });

  client.onMessage(async (message) => {
    if (!message.body || message.isGroupMsg) return;

    const from = message.from;
    const userMsg = message.body.trim();

    // Initialize or get user state
    let state = userStates.get(from) || { chatHistory: [], awaitingConfirmation: false };

    // Handle order confirmation step
    if (state.awaitingConfirmation) {
      if (userMsg.toLowerCase() === 'yes') {
        await placeOrder(client, from, state);
        userStates.delete(from);
        return;
      }
      if (userMsg.toLowerCase() === 'no') {
        await client.sendText(from, "Okay, please tell me your order again.");
        delete state.items;
        state.awaitingConfirmation = false;
        userStates.set(from, state);
        return;
      }
    }

    // Reset chat command
    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from);
      await client.sendText(from, "🔄 Chat has been reset. How may I assist you today?");
      return;
    }

    // Call AI to parse user message and detect intent, room number, and order items
    const parsed = await parseUserMessageWithAI(userMsg, state.chatHistory);

    // Update state with detected room number & items if any
    if (parsed.roomNumber) {
      state.room = parsed.roomNumber;
    }

    if (parsed.orderItems && parsed.orderItems.length > 0) {
      // Filter parsed items against menu, reject invalid
      const filteredItems = filterValidItems(parsed.orderItems);
      if (filteredItems.length === 0) {
        await client.sendText(from, "Sorry, none of the items you mentioned are on our menu. Please choose from our menu.");
        await sendFullMenu(client, from);
        return;
      }
      state.items = filteredItems;
    }

    // Handle special case: user provides room only after ordering items
    if (parsed.intent === 'provide_room_only' && state.items && state.items.length > 0) {
      await client.sendText(from, `Thanks! Room number set to ${state.room}. Shall I place your order for ${state.items.join(', ')}? Reply 'yes' or 'no'.`);
      state.awaitingConfirmation = true;
      userStates.set(from, state);
      return;
    }

    // Handle intents from AI parser
    switch (parsed.intent) {
      case 'order_food':
        if (!state.room) {
          await client.sendText(from, "Could you please provide your 3-4 digit room number?");
        } else if (!state.items || state.items.length === 0) {
          await client.sendText(from, "What would you like to order from our menu?");
        } else {
          await client.sendText(from, `Got it! Room: ${state.room}, Order: ${state.items.join(', ')}. Shall I place the order? Reply 'yes' or 'no'.`);
          state.awaitingConfirmation = true;
        }
        break;

      case 'ask_menu':
        await sendFullMenu(client, from);
        break;

      case 'greeting':
        await client.sendText(from, `Hello! Welcome to ${hotelConfig.name}. How can I assist you today?`);
        break;

      default:
        // Default fallback: AI generates a conversational reply
        const aiReply = await getContextualAIResponse(client, from, userMsg);
        await client.sendText(from, aiReply);
        break;
    }

    // Update chat history and user state
    state.chatHistory.push({ role: 'guest', content: userMsg });
    userStates.set(from, state);
  });

})
.catch(console.error);

/**
 * Uses Gemini AI to parse the user's message for intent, room number, and order items.
 * Returns an object: { intent: string, roomNumber: string|null, orderItems: string[] }
 */
async function parseUserMessageWithAI(message, chatHistory) {
  try {
    const prompt = `
You are an intelligent hotel concierge assistant. Analyze the guest's message and respond with a JSON object with:
- intent: one of ["order_food", "provide_room_only", "ask_menu", "greeting", "unknown"]
- roomNumber: 3 or 4 digit string if mentioned, else null
- orderItems: array of strings of items guest wants to order, else empty array

Guest message: """${message}"""

Hotel menu items:
${Object.values(hotelConfig.menu).flat().map(i => "- " + i.split(' - ')[0]).join('\n')}

Respond ONLY with the JSON object.

Example response:
{
  "intent": "order_food",
  "roomNumber": "594",
  "orderItems": ["Club Sandwich x3"]
}
`;

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    });

    const text = (await result.response).text();

    // Parse the JSON from AI response
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}') + 1;
    const jsonString = text.substring(jsonStart, jsonEnd);
    const data = JSON.parse(jsonString);

    // Normalize order items to just item names with quantity (remove extra chars)
    if (Array.isArray(data.orderItems)) {
      data.orderItems = data.orderItems.map(item => item.trim());
    } else {
      data.orderItems = [];
    }

    if (!data.intent) data.intent = 'unknown';
    if (!data.roomNumber) data.roomNumber = null;

    return data;

  } catch (err) {
    console.error('❌ Parsing AI error:', err);
    // fallback
    return { intent: 'unknown', roomNumber: null, orderItems: [] };
  }
}

/**
 * Places the order: saves it in JSON DB and notifies the manager/admin
 */
async function placeOrder(client, from, state) {
  if (!state.room || !state.items || state.items.length === 0) {
    await client.sendText(from, "Sorry, I need both room number and order details to place your order.");
    return;
  }

  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderId = Date.now();

  const newOrder = {
    id: orderId,
    room: state.room,
    items: state.items,
    guestNumber: from,
    status: "Pending",
    timestamp: new Date().toISOString()
  };

  orders.push(newOrder);
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  // Notify admin
  await client.sendText(hotelConfig.adminNumber, `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${state.items.join('\n')}`);

  // Confirm to guest
  await client.sendText(from, `Your order #${orderId} has been placed! It will arrive shortly.`);

  // Send rating buttons
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
    'Rate Us',
    'Tap one below to rate our service.'
  );
}

/**
 * Sends full hotel menu to the guest.
 */
async function sendFullMenu(client, number) {
  let text = `📋 Our Menu:\n\n`;
  for (const category in hotelConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${hotelConfig.hours[category]}):\n`;
    text += hotelConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "You can say things like 'I'd like to order 2 pancakes' or 'Can I get a towel + chicken sandwich?'\n";
  await client.sendText(number, text);
}

/**
 * Gets a contextual AI reply (fallback conversational)
 */
async function getContextualAIResponse(client, from, prompt) {
  try {
    const state = userStates.get(from) || {};

    const context = {
      hotel: hotelConfig.name,
      checkIn: hotelConfig.checkInTime,
      checkOut: hotelConfig.checkOutTime,
      menu: JSON.stringify(hotelConfig.menu),
      services: ["room service", "housekeeping", "restaurant"],
      language: 'en',
      previousMessages: state.chatHistory || []
    };

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are the concierge at ${hotelConfig.name}. Respond in English.

CONTEXT:
${JSON.stringify(context, null, 2)}

GUEST MESSAGE: "${prompt}"

INSTRUCTIONS:
Assist with food orders, check-in/out info, hotel services, and requests like towels.
Be polite and helpful.`
            }
          ]
        }
      ]
    });

    return (await result.response).text();

  } catch (err) {
    console.error("❌ AI Error:", err);
    return "I'm having trouble understanding. Could you please rephrase that?";
  }
}
