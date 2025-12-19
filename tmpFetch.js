const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
(async () => {
  const { data, error } = await supabase
    .from("specs")
    .select("spec_code,spec_name,updated_at")
    .order("updated_at", { ascending: false });
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(data);
})();
