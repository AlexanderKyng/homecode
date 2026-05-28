import { encode } from "@toon-format/toon"

// Interface pour typer proprement la sortie brute de SearXNG
interface SearXNGResult {
  title: string
  url: string
  content?: string
  snippet?: string
  engine: string
  score?: number
}

interface CodeSearchArgs {
  query: string
  category?: "qa" | "repos" | "all"
  maxResults?: number
}

/**
 * Outil CodeSearch optimisé pour OpenQCode (Moteurs Q&A et Repositories locaux via SearXNG)
 */
export async function codeSearch({ query, category = "all", maxResults = 5 }: CodeSearchArgs): Promise<string> {
  // URL de ton instance SearXNG locale (à ajuster via tes variables d'environnement si besoin)
  const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8080"

  // Préparation de la requête avec les Bangs SearXNG adaptés à ta configuration
  let formattedQuery = query
  if (category === "qa") {
    formattedQuery = `!q&a ${query}`
  } else if (category === "repos") {
    formattedQuery = `!repos ${query}`
  } else {
    // Par défaut, on peut combiner ou laisser SearXNG chercher dans les catégories IT par défaut
    // Ici on force le comportement multi-moteur orienté dév si aucun bang n'est spécifié
    formattedQuery = `!stackoverflow !github !ubuntu !superuser ${query}`
  }

  try {
    // Construction de l'URL d'appel avec format JSON imposé
    const searchUrl = new URL("/search", SEARXNG_URL)
    searchUrl.searchParams.append("q", formattedQuery)
    searchUrl.searchParams.append("format", "json")
    searchUrl.searchParams.append("pageno", "1")

    const response = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenQCode-LocalLLM-Agent/1.0",
      },
    })

    if (!response.ok) {
      throw new Error(`Erreur de communication avec SearXNG: ${response.statusText}`)
    }

    const data = await response.json()
    const rawResults: SearXNGResult[] = data.results || []

    // 1. Filtrage et nettoyage immédiat des données pour économiser la mémoire vive avant TOON
    const cleanedResults = rawResults.slice(0, maxResults).map((item) => {
      // Garder uniquement la substantifique moelle
      return {
        title: item.title?.trim() || "No Title",
        url: item.url,
        source: item.engine,
        // Fusion du snippet ou du content selon ce que le moteur SearXNG renvoie
        summary: (item.snippet || item.content || "").replace(/\s+/g, " ").trim(),
      }
    })

    if (cleanedResults.length === 0) {
      return encode({
        status: "no_results",
        message: "Aucun snippet ou dépôt trouvé pour cette recherche.",
      })
    }

    // 2. Encapsulation dans un schéma optimisé pour le format TOON
    // TOON va sérialiser ce tableau d'objets uniformes sous forme de table compacte (façon CSV sans bruit)
    const payload = {
      query_executed: query,
      engine_category: category,
      results_count: cleanedResults.length,
      results: cleanedResults,
    }

    // 3. Encodage magique en TOON pour Qwen
    return encode(payload)
  } catch (error: any) {
    // Retour d'erreur propre et structuré en TOON pour éviter que le LLM ne perde le fil
    return encode({
      status: "error",
      message: error.message || "Une erreur inconnue est survenue lors de la recherche de code.",
    })
  }
}
