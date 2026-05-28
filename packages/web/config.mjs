const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://openqcode.ai" : `https://${stage}.openqcode.ai`,
  console: stage === "production" ? "https://openqcode.ai/auth" : `https://${stage}.openqcode.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/openqcode",
  discord: "https://openqcode.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
