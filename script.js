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
// NOTE: It's best practice to use environment variables for API keys in production.
// For example: process.env.GEMINI_API_KEY
const genAI = new GoogleGenerativeAI("AIzaSyASc5JDTn-7mD6_CUefisGlkP9aRUHETUM"); // Replace with your actual API key or env variable
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Ensure orders.json database file exists
if (!fs.existsSync(hotelConfig.databaseFile)) {
  fs.writeFileSync(hotelConfig.databaseFile, '[]');
}

// Map to store user conversation states
const userStates = new Map();

// Create Venom-bot instance
venom.create({
  session: 'hotel-bot',
  headless: 'new', // Changed from 'true' to 'new' to fix deprecation warning
  useChrome: false, // Prevents Venom from trying to download its own Chrome
  sessionFolder: './tokens', // Folder to store WhatsApp session tokens
  multidevice: true, // Enable multi-device support
  cacheEnabled: false, // Disable cache
  disableSpins: true, // Disable spinner animations
  killProcessOnBrowserClose: true, // Kill the browser process when closed
  puppeteerOptions: {
    args: [
      '--no-sandbox', // Required for many Linux environments, including Render
      '--disable-setuid-sandbox', // Required for many Linux environments
      '--disable-dev-shm-usage', // Important for memory-constrained environments like Render
      '--single-process', // Can reduce memory usage
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu', // Disable GPU hardware acceleration
      '--enable-features=NetworkService,NetworkServiceInProcess' // Improve network stability
    ],
    // Explicitly set executablePath for Render compatibility.
    // Order of preference: Render's CHROME_BIN, Puppeteer's default env var, common Linux path.
    // We are trying multiple paths where Chrome might be found on a Render machine.
    executablePath: process.env.CHROME_BIN || 
                    process.env.PUPPETEER_EXECUTABLE_PATH || 
                    '/usr/bin/google-chrome' || 
                    '/usr/bin/chromium-browser'
  },
  // Add a listener to capture QR code data for login
  onStreamData: (data) => {
    // Check if the data type is a QR code
    if (data.type === 'qrRead') {
      console.log('--- SCAN THIS QR CODE TO LOG IN ---');
      console.log('Open a base64 to image converter (e.g., https://codebeautify.org/base64-to-image-converter)');
      console.log('Paste the following string into the converter to get your QR code:');
      console.log(data.qrCode); // This is the base64 QR code string
      console.log('------------------------------------');
    }
  }
})
.then(client => {
  console.log("✅ WhatsApp Bot Ready");
  // Set the venom client in the server module for WhatsApp notifications
  setClient(client);

  // Start the Express server for the admin dashboard
 app.listen(PORT, () => { // Changed 3000 to PORT
  console.log(`🌐 Dashboard running at http://localhost:${PORT}/admin.html`);
});

  // Listen for incoming WhatsApp messages
  client.onMessage(async (message) => {
    // Ignore empty messages or group messages
    if (!message.body || message.isGroupMsg) return;

    const from = message.from; // Sender's WhatsApp number
    const rawMsg = message.body.trim(); // Trim whitespace from message
    const isNepali = rawMsg.startsWith('/ne '); // Check if message starts with Nepali command
    const userMsg = isNepali ? rawMsg.replace('/ne ', '') : rawMsg; // Extract user message

    // Handle rating button responses from WhatsApp
    if (message.type === 'buttons_response' || message.type === 'button') {
      const ratingIds = ['star_1', 'star_2', 'star_3', 'star_3', 'star_5']; // Corrected 'star_3' duplication
      const selectedId = message.selectedButtonId || message.selectedButtonId; // Get selected button ID
      if (ratingIds.includes(selectedId)) {
        const rating = selectedId.replace('star_', ''); // Extract rating number
        await client.sendText(from, `Thank you for rating us ⭐${rating}!`); // Send thank you message
        return; // Stop further processing
      }
    }

    // Initialize or update user state for language preference
    if (!userStates.has(from)) {
      userStates.set(from, { lang: isNepali ? 'ne' : 'en', chatHistory: [] });
    } else if (isNepali) {
      userStates.get(from).lang = 'ne';
    }

    // Handle 'reset' command to clear chat history
    if (userMsg.toLowerCase() === 'reset') {
      userStates.delete(from); // Delete user state
      await client.sendText(from, "🔄 Chat has been reset. How may I assist you today?");
      return;
    }

    // Handle manager commands if the sender is the admin
    if (from === hotelConfig.adminNumber && await handleManagerCommands(client, userMsg)) return;

    // Handle ongoing conversational steps (e.g., ordering process)
    if (await handleOngoingConversation(client, from, userMsg)) return;

    // Get a contextual AI response using Gemini
    const aiResponse = await getContextualAIResponse(client, from, userMsg);
    await client.sendText(from, aiResponse); // Send AI response back to user
  });

}).catch(console.error); // Catch any errors during Venom creation

/**
 * Gets a contextual AI response from the Gemini model.
 * @param {object} client - The Venom client instance.
 * @param {string} from - The sender's WhatsApp number.
 * @param {string} prompt - The user's message.
 * @returns {string} The AI generated response.
 */
async function getContextualAIResponse(client, from, prompt) {
  try {
    const state = userStates.get(from) || {}; // Get current user state

    // Prepare context for the AI model
    const context = {
      hotel: hotelConfig.name,
      checkIn: hotelConfig.checkInTime,
      checkOut: hotelConfig.checkOutTime,
      menu: JSON.stringify(hotelConfig.menu), // Stringify menu for AI context
      services: ["room service", "housekeeping", "restaurant"],
      currentState: state.step || "new_conversation",
      previousMessages: state.chatHistory || [],
      language: state.lang || 'en'
    };

    // Generate content using the Gemini model
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

    const responseText = (await result.response).text(); // Extract text from AI response
    // Perform actions based on AI response or user prompt
    await handleAIResponseActions(client, from, prompt, responseText);

    // Update user chat history
    if (!userStates.has(from)) userStates.set(from, { chatHistory: [] });
    userStates.get(from).chatHistory.push({ role: "guest", content: prompt }, { role: "bot", content: responseText });

    return responseText;
  } catch (err) {
    console.error("❌ AI Error:", err);
    return "I'm having trouble understanding. Could you please rephrase that?";
  }
}

/**
 * Handles actions based on AI response or user prompt keywords.
 * @param {object} client - The Venom client instance.
 * @param {string} from - The sender's WhatsApp number.
 * @param {string} prompt - The user's original message.
 * @param {string} responseText - The AI generated response.
 */
async function handleAIResponseActions(client, from, prompt, responseText) {
  const lowerPrompt = prompt.toLowerCase();
  const lowerResponse = responseText.toLowerCase();

  // If prompt includes common request keywords, confirm the request
  if (lowerPrompt.includes("towel") || lowerPrompt.includes("blanket") || lowerPrompt.includes("water")) {
    await client.sendText(from, "✅ Your request has been noted. A staff member will attend to your room shortly.");
  }

  // If prompt or response indicates an order intent, initiate order process
  if (lowerResponse.includes('order') || lowerPrompt.includes('order') || lowerPrompt.includes('want to eat') || lowerPrompt.includes('hungry')) {
    await initiateOrderProcess(client, from);
  }
  // If prompt asks for menu and AI hasn't explicitly listed menu items, send full menu
  if ((lowerPrompt.includes('menu') || lowerPrompt.includes('show me food') || lowerPrompt.includes('what can i eat')) && !lowerResponse.includes('continental breakfast')) {
    await sendFullMenu(client, from);
  }
}

/**
 * Initiates the food ordering process by asking for the room number.
 * @param {object} client - The Venom client instance.
 * @param {string} from - The sender's WhatsApp number.
 */
async function initiateOrderProcess(client, from) {
  // If an order process is already ongoing, do nothing
  if (userStates.has(from) && userStates.get(from).step) return;
  await client.sendText(from, "May I have your room number to start your order?");
  userStates.set(from, {
    ...userStates.get(from),
    step: 'awaiting_room' // Set state to await room number
  });
}

/**
 * Handles ongoing conversational steps for the ordering process.
 * @param {object} client - The Venom client instance.
 * @param {string} from - The sender's WhatsApp number.
 * @param {string} userMsg - The user's message.
 * @returns {boolean} True if the message was handled as part of an ongoing conversation, false otherwise.
 */
async function handleOngoingConversation(client, from, userMsg) {
  if (!userStates.has(from)) return false; // No ongoing conversation
  const state = userStates.get(from);

  // Step 1: Awaiting room number
  if (state.step === 'awaiting_room') {
    const match = userMsg.match(/room\s*(\d{3,4})/i) || userMsg.match(/(\d{3,4})/); // Try to extract room number
    const roomNumber = match ? match[1] : null;
    if (!roomNumber) {
      await client.sendText(from, "Please enter a valid 3-4 digit room number:");
      return true; // Message handled, awaiting valid room number
    }
    userStates.set(from, { ...state, step: 'awaiting_order', room: roomNumber }); // Store room and move to next step
    await client.sendText(from, `Thank you! What would you like to order from our menu?`);
    return true; // Message handled
  }

  // Step 2: Awaiting order items
  if (state.step === 'awaiting_order') {
    const { found, unavailable } = findOrderItems(userMsg); // Parse items from message
    if (!found.length) {
      await client.sendText(from, "I couldn't find any valid items. Would you like to see our menu again?");
      await sendFullMenu(client, from); // Send menu if no valid items found
      return true; // Message handled, awaiting order
    }
    userStates.set(from, {
      ...state,
      step: 'awaiting_confirmation', // Store items and move to confirmation step
      items: found
    });

    let response = `Your order:\nRoom ${state.room}\nItems:\n${found.join('\n')}`;
    if (unavailable.length) {
      response += `\n\n⚠️ These items are not available: ${unavailable.join(', ')}`;
    }
    response += `\n\nDoes this look correct? (Reply "yes" to confirm or "no" to change)`;

    await client.sendText(from, response);
    return true; // Message handled
  }

  // Step 3: Awaiting order confirmation
  if (state.step === 'awaiting_confirmation') {
    if (userMsg.toLowerCase().includes('yes')) {
      const orderId = Date.now(); // Generate unique order ID
      const newOrder = {
        id: orderId,
        room: state.room,
        items: state.items,
        guestNumber: from,
        status: "Pending",
        timestamp: new Date().toISOString() // Store timestamp
      };

      // Load, add, and save the new order to the JSON file
      const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
      orders.push(newOrder);
      fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

      // Notify manager of the new order
      await notifyManager(client, `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${state.items.join('\n')}`);
      await client.sendText(from, `Your order #${orderId} has been placed! It will arrive in 30-45 minutes.`);

      // Send feedback buttons to the guest
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
      
      userStates.delete(from); // Clear user state after order is placed
      return true; // Message handled
    } else if (userMsg.toLowerCase().includes('no')) {
      userStates.set(from, { ...state, step: 'awaiting_order' }); // Go back to awaiting order items
      await client.sendText(from, "Let's try again. What would you like to order?");
      return true; // Message handled
    }
  }

  return false; // Message not handled by ongoing conversation
}

/**
 * Handles manager commands (e.g., confirm, done).
 * @param {object} client - The Venom client instance.
 * @param {string} message - The manager's message.
 * @returns {boolean} True if a manager command was handled, false otherwise.
 */
async function handleManagerCommands(client, message) {
  const confirmMatch = message.match(/^confirm\s+#(\d+)$/i); // Match 'confirm #ID'
  const doneMatch = message.match(/^done\s+#(\d+)$/i); // Match 'done #ID'

  if (confirmMatch) return await updateOrderStatus(client, confirmMatch[1], "Confirmed");
  if (doneMatch) return await updateOrderStatus(client, doneMatch[1], "Done"); // Use "Done" as defined in server.js
  return false;
}

/**
 * Updates the status of an order and notifies the guest.
 * @param {object} client - The Venom client instance.
 * @param {string} orderId - The ID of the order.
 * @param {string} newStatus - The new status ('Confirmed', 'Done', 'Rejected').
 * @returns {boolean} True if the status was updated, false otherwise.
 */
async function updateOrderStatus(client, orderId, newStatus) {
  const orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile));
  const orderIndex = orders.findIndex(o => o.id.toString() === orderId);
  if (orderIndex === -1) {
    await client.sendText(hotelConfig.adminNumber, `Order #${orderId} not found.`);
    return true;
  }

  const order = orders[orderIndex];
  orders[orderIndex].status = newStatus; // Update order status
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2)); // Save updated orders

  await client.sendText(hotelConfig.adminNumber, `Order #${orderId} marked as ${newStatus}.`);
  // Notify the guest about the status update
  if (order.guestNumber && order.guestNumber.endsWith('@c.us')) {
      let msg = '';
      switch (newStatus) {
          case 'Confirmed':
              msg = `✅ Your order #${orderId} has been *confirmed* and is now being prepared. Please wait.`;
              break;
          case 'Done':
              msg = `✅ Your order #${orderId} has been *completed*. Thank you for staying with us!`;
              break;
          case 'Rejected': // Though not directly triggered by manager command, added for completeness
              msg = `❌ Your order #${orderId} was *rejected* by the manager. Please contact reception for help.`;
              break;
      }
      if (msg) {
          try {
              await client.sendText(order.guestNumber, msg);
              console.log(`📩 WhatsApp update sent to guest ${order.guestNumber} → ${newStatus}`);
          } catch (err) {
              console.error('⚠️ Failed to notify guest via WhatsApp:', err.message);
          }
      }
  }

  return true;
}

/**
 * Parses a message to find matching order items from the hotel menu.
 * @param {string} msg - The user's message containing order requests.
 * @returns {{found: string[], unavailable: string[]}} Object with found and unavailable items.
 */
function findOrderItems(msg) {
  const found = [];
  const unavailable = []; // In this version, unavailable is always empty as requested
  const lowerMsg = msg.toLowerCase();

  for (const category in hotelConfig.menu) {
    for (const item of hotelConfig.menu[category]) {
      const [name, priceStr] = item.split(' - ₹');
      const nameLower = name.toLowerCase();

      // Regex to match quantity + item name or just item name
      const regex = new RegExp(`(\\d+)?\\s*${nameLower}`, 'i');
      const match = lowerMsg.match(regex);

      let quantity = 0;
      if (match) {
        quantity = match[1] ? parseInt(match[1]) : 1; // Default quantity to 1 if not specified
      }

      if (quantity > 0) {
        const price = parseInt(priceStr);
        const total = price * quantity;
        found.push(`${name} x${quantity} - ₹${total}`);
      }
    }
  }
  return { found, unavailable };
}

/**
 * Notifies the manager via WhatsApp.
 * @param {object} client - The Venom client instance.
 * @param {string} text - The message to send to the manager.
 */
async function notifyManager(client, text) {
  try {
    await client.sendText(hotelConfig.adminNumber, text);
  } catch (err) {
    console.error("Failed to notify manager:", err.message);
  }
}

/**
 * Sends the full hotel menu to a guest via WhatsApp.
 * @param {object} client - The Venom client instance.
 * @param {string} number - The guest's WhatsApp number.
 */
async function sendFullMenu(client, number) {
  let text = `📋 Our Menu:\n\n`;
  for (const category in hotelConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${hotelConfig.hours[category]}):\n`;
    text += hotelConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "\nYou can say things like 'I'd like to order 2 pancakes' or 'Can I get a towel + chicken sandwich?'";
  await client.sendText(number, text);
}
