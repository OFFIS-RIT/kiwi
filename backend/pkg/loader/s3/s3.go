package s3

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"golang.org/x/sync/singleflight"

	"kiwi/pkg/loader"
)

func getBase64Prefix(filePath string) string {
	nameSplit := strings.Split(filePath, ".")
	if len(nameSplit) < 2 {
		return "data:application/octet-stream;base64,"
	}
	ext := nameSplit[len(nameSplit)-1]
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return fmt.Sprintf("data:%s;base64,", mimeType)
}

// S3GraphFileLoader is a GraphFileLoader implementation that loads file
// contents from an Amazon S3 bucket. It uses the AWS SDK v2 for Go.
//
// This loader is useful when your graph input files are stored in S3
// instead of the local filesystem.
type S3GraphFileLoader struct {
	bucket string
	client *s3.Client

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewS3GraphFileLoaderWithClient creates a new S3GraphFileLoader using an
// existing s3.Client. This is useful if you want to reuse a preconfigured
// AWS client (e.g., with custom middleware or credentials).
func NewS3GraphFileLoaderWithClient(bucket string, client *s3.Client) *S3GraphFileLoader {
	return &S3GraphFileLoader{
		bucket: bucket,
		client: client,
		cache:  make(map[string][]byte),
	}
}

// NewS3GraphFileLoaderParams defines the configuration parameters for
// creating a new S3GraphFileLoader.
//
// Bucket specifies the S3 bucket name.
// Endpoint allows overriding the S3 endpoint (useful for S3-compatible
// storage like MinIO).
// Region specifies the AWS region.
// AccessKey and SecretKey provide static credentials.
type NewS3GraphFileLoaderParams struct {
	Bucket    string
	Endpoint  string
	Region    string
	AccessKey string
	SecretKey string
}

// NewS3GraphFileLoader creates a new S3GraphFileLoader using the provided
// parameters. It initializes an AWS S3 client with static credentials and
// the given endpoint/region.
//
// Example:
//
//	loader, err := files.NewS3GraphFileLoader(ctx, files.NewS3GraphFileLoaderParams{
//		Bucket:    "my-bucket",
//		Endpoint:  "https://s3.amazonaws.com",
//		Region:    "us-east-1",
//		AccessKey: os.Getenv("AWS_ACCESS_KEY_ID"),
//		SecretKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
//	})
//	if err != nil {
//		log.Fatal(err)
//	}
//
//	file := files.GraphFile{ID: "1", FilePath: "docs/input.txt", Loader: loader}
//	text, err := file.GetText(ctx)
func NewS3GraphFileLoader(ctx context.Context, params NewS3GraphFileLoaderParams) (*S3GraphFileLoader, error) {
	cfg, err := config.LoadDefaultConfig(
		ctx,
		config.WithRegion(params.Region),
		config.WithBaseEndpoint(params.Endpoint),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			params.AccessKey,
			params.SecretKey,
			"",
		)),
	)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg)

	return &S3GraphFileLoader{
		bucket: params.Bucket,
		client: client,
		cache:  make(map[string][]byte),
	}, nil
}

// GetFileText retrieves the contents of the given GraphFile from the
// configured S3 bucket. It implements the GraphFileLoader interface.
func (l *S3GraphFileLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	cacheKey := loader.CacheKey(file)

	l.cacheMu.RLock()
	if cached, ok := l.cache[cacheKey]; ok {
		l.cacheMu.RUnlock()
		return cached, nil
	}
	l.cacheMu.RUnlock()

	result, err, _ := l.group.Do(cacheKey, func() (any, error) {
		l.cacheMu.RLock()
		if cached, ok := l.cache[cacheKey]; ok {
			l.cacheMu.RUnlock()
			return cached, nil
		}
		l.cacheMu.RUnlock()

		key := file.FilePath
		bucket := l.bucket

		out, err := l.client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(bucket),
			Key:    aws.String(key),
		})
		if err != nil {
			return nil, err
		}
		defer out.Body.Close()

		buf := new(bytes.Buffer)
		if _, err := io.Copy(buf, out.Body); err != nil {
			return nil, err
		}

		byts := buf.Bytes()

		l.cacheMu.Lock()
		l.cache[cacheKey] = byts
		l.cacheMu.Unlock()

		return byts, nil
	})

	return result.([]byte), err
}

func (l *S3GraphFileLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	b, err := l.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	result := base64.StdEncoding.EncodeToString(b)
	fileTypePrefix := getBase64Prefix(file.FilePath)
	return loader.GraphBase64{
		Base64:   result,
		FileType: fileTypePrefix,
	}, nil
}
