// The only file you need to edit. Both the app and the website pages read it.
// Everything here is public by design (it is shipped inside the app). Never put a secret key in this file.
window.APP_CONFIG = {
  // Supabase dashboard -> Project Settings -> API -> "Project URL"
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_PROJECT_URL",
  // Supabase dashboard -> Project Settings -> API -> the "anon public" key (a long text starting with eyJ...)
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY",

  // What people pay once after registering, in rupees. (The payment function has its own PRICE_RUPEES secret; keep both the same.)
  PRICE_RUPEES: 500,

  // Where your Terms / Privacy / Refund pages live, e.g. "https://yourname.github.io/cutting-room/"
  POLICY_URL: "PASTE_YOUR_GITHUB_PAGES_ADDRESS",

  // Shown to users for help. Leave SUPPORT_WHATSAPP empty if you do not want it shown.
  SUPPORT_EMAIL: "you@example.com",
  SUPPORT_WHATSAPP: "",

  // Your business name for the legal pages.
  BUSINESS_NAME: "Cutting Room"
};
