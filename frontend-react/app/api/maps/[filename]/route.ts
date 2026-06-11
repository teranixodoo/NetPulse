import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export async function GET(
  request: NextRequest,
  { params }: { params: { filename: string } }
) {
  const { filename } = params;

  // Bezpečnostní kontrola — pouze .kml soubory, žádné path traversal
  if (!filename.endsWith(".kml") || filename.includes("..") || filename.includes("/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    // V Docker kontejneru je shared/maps namountováno jako /shared/maps
    // Lokálně (dev) hledáme v ../../shared/maps od /app
    const candidates = [
      "/shared/maps/" + filename,
      path.join(process.cwd(), "..", "shared", "maps", filename),
    ];

    let content: string | null = null;
    for (const kmlPath of candidates) {
      try {
        content = await readFile(kmlPath, "utf-8");
        break;
      } catch {}
    }

    if (!content) {
      return new NextResponse(`KML file not found: ${filename}`, { status: 404 });
    }

    return new NextResponse(content, {
      headers: {
        "Content-Type":  "application/vnd.google-earth.kml+xml",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    return new NextResponse(`Error reading KML: ${err}`, { status: 500 });
  }
}
