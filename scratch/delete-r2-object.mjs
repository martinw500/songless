import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
for (const name of required) { if (!process.env[name]?.trim()) throw new Error(name + " missing"); }
const client = new S3Client({
  region: "auto",
  endpoint: "https://" + process.env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com",
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});
await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: "audio/full/onerepublic-counting-stars.mp3" }));
await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: "audio/clues/onerepublic-counting-stars.mp3" }));
console.log("Deleted old Counting Stars audio from R2.");
