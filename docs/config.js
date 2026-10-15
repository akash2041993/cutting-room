// The only file you need to edit. Both the app and the website pages read it.
// Everything here is public by design (it is shipped inside the app). Never put a secret key in this file.
window.APP_CONFIG = {
  // Supabase dashboard -> Project Settings -> API -> "Project URL"
  SUPABASE_URL: "https://zyywpklxotgawhcuqjse.supabase.co",
  // Supabase dashboard -> Project Settings -> API -> the "anon public" key (a long text starting with eyJ...)
  SUPABASE_ANON_KEY: "sb_publishable_1I6IlLlRJTeab1bVQEw-iw_Ez_g_Xxe",

  // What people pay once after registering, in rupees. (The payment function has its own PRICE_RUPEES secret; keep both the same.)
  PRICE_RUPEES: 500,

  // Where your Terms / Privacy / Refund pages live, e.g. "https://yourname.github.io/cutting-room/"
  POLICY_URL: "https://akash2041993.github.io/cutting-room/",

  // Shown to users for help. Leave SUPPORT_WHATSAPP empty if you do not want it shown.
  SUPPORT_EMAIL: "azoneindore@gmail.com",
  SUPPORT_WHATSAPP: "+91 8871798578",

  // Your business name for the legal pages.
  BUSINESS_NAME: "VE Room"
};
