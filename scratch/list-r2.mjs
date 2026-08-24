import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({
  region: "auto",
  endpoint: "https://" + process.env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com",
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
});
const page = await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET }));
const c = page.Contents.filter(x => x.Key.includes("onerepublic-counting-stars"));
console.log(c.map(x=>x.Key).join(", "));
