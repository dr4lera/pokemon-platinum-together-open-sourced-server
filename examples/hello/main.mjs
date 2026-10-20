// Enable this plugin in plugin.json, then reload plugins on the hosting PC.
// Type /hello your message in the existing in-game chat.
export async function onEvent(event, context) {
  if (event.type === 'command')
    return {reply: `Hello ${event.data.username}! ${event.data.args}`.slice(0, 300)};
  if (event.type === 'call')
    return {message: 'Hello from your custom server plugin.', player: event.data.player};
  // context.dataDirectory is this plugin's persistent local storage folder.
}
