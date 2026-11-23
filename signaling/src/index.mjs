// Lambda entry: adapts a Function URL event to logic.mjs with a DynamoDB store.
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { handle } from "./logic.mjs";
import { turnProvider } from "./turn.mjs";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;
const TTL_SECONDS = Number(process.env.TTL_SECONDS || 3600);
const turn = turnProvider();

const store = {
  async get(id) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    const item = r.Item;
    // TTL deletion can lag by hours; treat expired items as gone.
    if (!item || item.ttl < Date.now() / 1000) return null;
    return item;
  },
  async put(item, cond) {
    const params = { TableName: TABLE, Item: item };
    const now = Math.floor(Date.now() / 1000);
    if (cond.notExists) {
      params.ConditionExpression = "attribute_not_exists(id) OR #t < :now";
      params.ExpressionAttributeNames = { "#t": "ttl" };
      params.ExpressionAttributeValues = { ":now": now };
    } else if (cond.notExistsOrOwner) {
      params.ConditionExpression = "attribute_not_exists(id) OR #o = :o OR #t < :now";
      params.ExpressionAttributeNames = { "#o": "owner", "#t": "ttl" };
      params.ExpressionAttributeValues = { ":o": cond.notExistsOrOwner, ":now": now };
    }
    try {
      await db.send(new PutCommand(params));
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  },
  async del(id) {
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
  },
};

export const handler = async (event) => {
  const raw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : null;
  try {
    return await handle(
      {
        method: event.requestContext?.http?.method,
        path: event.rawPath,
        headers: event.headers || {},
        body: raw,
      },
      store,
      TTL_SECONDS,
      turn,
    );
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: '{"error":"internal"}' };
  }
};
