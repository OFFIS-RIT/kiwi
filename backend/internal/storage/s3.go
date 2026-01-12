package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"mime"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func NewS3Client(ctx context.Context) *s3.Client {
	region := util.GetEnv("AWS_REGION")
	endpoint := util.GetEnv("AWS_ENDPOINT")
	accessKey := util.GetEnv("AWS_ACCESS_KEY")
	secretKey := util.GetEnv("AWS_SECRET_KEY")
	util.GetEnv("AWS_BUCKET")
	cfg, err := config.LoadDefaultConfig(
		ctx,
		config.WithRegion(region),
		config.WithBaseEndpoint(endpoint),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			accessKey,
			secretKey,
			"",
		)),
	)
	if err != nil {
		return nil
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	})
	return client
}

func GetFile(ctx context.Context, client *s3.Client, key string) (*[]byte, error) {
	bucket := util.GetEnv("AWS_BUCKET")
	result, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return &[]byte{}, fmt.Errorf("failed to get file from S3: %v", err)
	}
	defer result.Body.Close()

	buf := new(bytes.Buffer)
	if _, err := io.Copy(buf, result.Body); err != nil {
		return &[]byte{}, fmt.Errorf("failed to read file contents: %v", err)
	}

	bytes := buf.Bytes()

	return &bytes, nil
}

func PutFile(ctx context.Context, client *s3.Client, path string, name string, key string, file io.ReadSeeker) (string, error) {
	bucket := util.GetEnv("AWS_BUCKET")
	splitExt := strings.Split(name, ".")
	ext := splitExt[len(splitExt)-1]
	mimeType := mime.TypeByExtension(ext)
	_, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(fmt.Sprintf("%s/%s.%s", path, key, ext)),
		Body:        file,
		ContentType: aws.String(mimeType),
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload file to S3: %v", err)
	}

	return fmt.Sprintf("%s/%s.%s", path, key, ext), nil
}

func DeleteFile(ctx context.Context, client *s3.Client, key string) error {
	bucket := util.GetEnv("AWS_BUCKET")
	_, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to delete file from S3: %v", err)
	}

	return nil
}

func GenerateDownloadLink(ctx context.Context, baseClient *s3.Client, key string) (string, error) {
	bucket := util.GetEnv("AWS_BUCKET")
	publicEndpoint := util.GetEnv("AWS_PUBLIC_ENDPOINT")

	publicURL, err := url.Parse(publicEndpoint)
	if err != nil || publicURL.Scheme == "" || publicURL.Host == "" {
		return "", fmt.Errorf("invalid AWS_PUBLIC_ENDPOINT: %s", publicEndpoint)
	}
	prefix := strings.TrimSuffix(publicURL.Path, "/")

	// Build the base endpoint (scheme + host only, no path)
	publicBaseEndpoint := fmt.Sprintf("%s://%s", publicURL.Scheme, publicURL.Host)

	// Use the public endpoint for presigning - this ensures the signature matches
	// the Host header that the client will send when accessing the URL
	presignClientS3 := s3.NewFromConfig(
		aws.Config{
			Region:      baseClient.Options().Region,
			Credentials: baseClient.Options().Credentials,
			HTTPClient:  baseClient.Options().HTTPClient,
		},
		func(o *s3.Options) {
			o.BaseEndpoint = aws.String(publicBaseEndpoint)
			o.UsePathStyle = true
		},
	)

	presigner := s3.NewPresignClient(presignClientS3)

	out, err := presigner.PresignGetObject(
		ctx,
		&s3.GetObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		},
		s3.WithPresignExpires(15*time.Minute),
	)
	if err != nil {
		return "", fmt.Errorf("failed to generate download link: %w", err)
	}

	// If there's a path prefix in the public endpoint, prepend it to the presigned URL path
	if prefix != "" {
		signedURL, parseErr := url.Parse(out.URL)
		if parseErr != nil {
			return "", fmt.Errorf("failed to parse presigned url: %w", parseErr)
		}
		signedURL.Path = prefix + signedURL.Path
		return signedURL.String(), nil
	}

	return out.URL, nil
}

func DeleteFolder(ctx context.Context, client *s3.Client, prefix string) error {
	bucket := util.GetEnv("AWS_BUCKET")

	listInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	}

	for {
		listOutput, err := client.ListObjectsV2(ctx, listInput)
		if err != nil {
			return fmt.Errorf("failed to list objects in folder %s: %w", prefix, err)
		}

		if len(listOutput.Contents) == 0 {
			break
		}

		var objectsToDelete []types.ObjectIdentifier
		for _, obj := range listOutput.Contents {
			objectsToDelete = append(objectsToDelete, types.ObjectIdentifier{
				Key: obj.Key,
			})
		}

		_, err = client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucket),
			Delete: &types.Delete{
				Objects: objectsToDelete,
				Quiet:   aws.Bool(true),
			},
		})
		if err != nil {
			return fmt.Errorf("failed to delete objects in folder %s: %w", prefix, err)
		}

		if listOutput.IsTruncated != nil && *listOutput.IsTruncated {
			listInput.ContinuationToken = listOutput.NextContinuationToken
		} else {
			break
		}
	}

	return nil
}

func ListFilesWithPrefix(ctx context.Context, client *s3.Client, prefix string) ([]string, error) {
	bucket := util.GetEnv("AWS_BUCKET")

	var keys []string
	listInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucket),
		Prefix: aws.String(prefix),
	}

	for {
		listOutput, err := client.ListObjectsV2(ctx, listInput)
		if err != nil {
			return nil, fmt.Errorf("failed to list objects with prefix %s: %w", prefix, err)
		}

		for _, obj := range listOutput.Contents {
			if obj.Key != nil {
				keys = append(keys, *obj.Key)
			}
		}

		if listOutput.IsTruncated != nil && *listOutput.IsTruncated {
			listInput.ContinuationToken = listOutput.NextContinuationToken
		} else {
			break
		}
	}

	return keys, nil
}
