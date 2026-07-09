import { NextRequest, NextResponse } from "next/server";
import { saveRequestResponse } from "@/lib/server/proxy-clients";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requestId, status, headers, body: responseBody, error } = body as {
      requestId: string;
      status: number;
      headers: Record<string, string>;
      body: unknown;
      error?: string;
    };

    if (!requestId) {
      return NextResponse.json(
        { error: "requestId is required" },
        { status: 400 }
      );
    }

    await saveRequestResponse(requestId, {
      status: status ?? 500,
      headers: headers ?? {},
      body: responseBody,
      error,
    });

    return NextResponse.json({
      success: true,
    });
  } catch (err) {
    console.error("Error saving response:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
