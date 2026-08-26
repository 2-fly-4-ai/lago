export default {
  fetch(): Response {
    return Response.json(
      {
        error: {
          code: "operator_access_bootstrap",
          message: "Operator access is not configured",
        },
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  },
} satisfies ExportedHandler;
