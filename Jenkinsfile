pipeline {
    agent any

    environment {
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-credentials')
        DOCKERHUB_IMAGE = 'quangnv1911/redmine-mcp-server-tci'

        IMAGE_TAG = 'latest'
        BRANCH_NAME = "${env.GIT_BRANCH.replaceFirst(/^origin\//, '')}"

        CONTAINER_NAME = 'redmine-mcp-server-tci'

        JOB_NAME = "${env.JOB_NAME}"
        BUILD_NUMBER = "${env.BUILD_NUMBER}"
    }

    stages {
        // ================================================
        // 1. LINT & TYPE CHECK (non-main branches)
        // ================================================
        stage('Lint & Type Check') {
            when {
                not { branch 'main' }
            }
            steps {
                script {
                    echo "Running lint & type check for branch: ${BRANCH_NAME}"

                    docker.image('node:22-alpine').inside {
                        sh 'npm ci'
                        sh 'npx tsc --noEmit'
                        sh 'npx eslint .'
                    }

                    echo "Lint & type check passed"
                }
            }
        }

        // ================================================
        // 2. BUILD DOCKER IMAGE
        // ================================================
        stage('Build Docker Image') {
            when { branch 'main' }
            steps {
                script {
                    echo "Building Docker image..."

                    sh """
                        docker pull ${DOCKERHUB_IMAGE}:${IMAGE_TAG} || true
                    """

                    sh """
                        docker build \
                            --cache-from ${DOCKERHUB_IMAGE}:${IMAGE_TAG} \
                            -t ${DOCKERHUB_IMAGE}:${IMAGE_TAG} .
                    """

                    echo "Docker image built successfully"
                }
            }
        }

        // ================================================
        // 3. PUSH DOCKER IMAGE
        // ================================================
        stage('Push Docker Image') {
            when { branch 'main' }
            steps {
                script {
                    echo "Pushing Docker image to Docker Hub..."

                    sh """
                        echo ${DOCKERHUB_CREDENTIALS_PSW} | docker login -u ${DOCKERHUB_CREDENTIALS_USR} --password-stdin
                    """

                    sh """
                        docker push ${DOCKERHUB_IMAGE}:${IMAGE_TAG}
                    """

                    echo "Docker image pushed successfully"
                }
            }
        }

        // ================================================
        // 4. CLEANUP LOCAL IMAGES
        // ================================================
        stage('Cleanup Local Images') {
            when { branch 'main' }
            steps {
                script {
                    echo "Cleaning up local Docker images..."
                    sh 'docker image prune -af || true'
                    echo "Cleanup completed"
                }
            }
        }

        // ================================================
        // 5. DEPLOY TO SERVER
        // ================================================
        stage('Deploy to Server') {
            when { branch 'main' }
            steps {
                script {
                    echo "Deploying Redmine MCP Server to Production..."

                    withCredentials([
                        string(credentialsId: 'remote-server-prod-host', variable: 'REMOTE_HOST'),
                        string(credentialsId: 'remote-server-prod-user', variable: 'REMOTE_USER'),
                        string(credentialsId: 'remote-server-prod-port', variable: 'REMOTE_PORT'),
                        sshUserPrivateKey(credentialsId: 'remote-ssh-key-prod', keyFileVariable: 'SSH_KEY')
                    ]) {
                        // Pull latest image
                        sh """
                            ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT} ${REMOTE_USER}@${REMOTE_HOST} '
                                echo "Pulling latest image..."
                                docker pull ${DOCKERHUB_IMAGE}:${IMAGE_TAG}
                            '
                        """

                        // Stop & remove old container
                        sh """
                            ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT} ${REMOTE_USER}@${REMOTE_HOST} '
                                docker stop ${CONTAINER_NAME} || true
                                docker rm ${CONTAINER_NAME} || true
                            '
                        """

                        // Run new container
                        sh """
                            ssh -o StrictHostKeyChecking=no -i $SSH_KEY -p $REMOTE_PORT $REMOTE_USER@$REMOTE_HOST '
                                ENV_FILE=".env.prod"
                                PORT_VAR="REDMINE_MCP_SERVER_PORT"
                                source ./infra/\${ENV_FILE}
                                eval "PORT=\\\$\${PORT_VAR}"

                                echo "Running ${CONTAINER_NAME} -> Port: \$PORT"

                                docker run -d --name ${CONTAINER_NAME} --env-file ./infra/\$ENV_FILE --network prod-network -p \$PORT:3000 -v /logs/redmine-mcp-server:/app/logs --restart unless-stopped ${DOCKERHUB_IMAGE}:${IMAGE_TAG}
                            '
                        """
                    }

                    echo "Deployed to Server successfully"
                }
            }
        }
    }

    post {
        always {
            script {
                echo "Pipeline execution completed"
            }
        }

        success {
            script {
                sendTelegramNotification('SUCCESS')
            }
        }

        failure {
            script {
                sendTelegramNotification('FAILED')
            }
        }

        cleanup {
            script {
                sh 'docker logout || true'
            }
        }
    }
}

// ===================================================================================
// TELEGRAM NOTIFICATION
// ===================================================================================
def sendTelegramNotification(String status) {
    def icon = status == 'SUCCESS' ? '✅' : '❌'
    def label = status == 'SUCCESS' ? 'PIPELINE SUCCESS' : 'PIPELINE FAILED'

    withCredentials([
        string(credentialsId: 'telegram-bot-token', variable: 'TELEGRAM_BOT_TOKEN'),
        string(credentialsId: 'telegram-chat-id', variable: 'TELEGRAM_CHAT_ID')
    ]) {
        def message = """
${icon} *${label}*

📦 Project: *Redmine MCP Server TCI*
🧩 Job: *${env.JOB_NAME}*
🔢 Build: #${env.BUILD_NUMBER}
🌿 Branch: ${env.GIT_BRANCH ?: 'N/A'}
🧾 Commit: ${env.GIT_COMMIT?.take(7) ?: 'N/A'}
⏱ Duration: ${currentBuild.durationString}
👤 Triggered by: ${env.BUILD_USER ?: 'System'}
${status == 'FAILED' ? "\n🚨 Status: *${currentBuild.currentResult}*" : ''}
🔗 Build URL:
${env.BUILD_URL}
        """.stripIndent()

        sh """
            curl -s -X POST https://api.telegram.org/bot\$TELEGRAM_BOT_TOKEN/sendMessage \
            -d chat_id=\$TELEGRAM_CHAT_ID \
            -d parse_mode=Markdown \
            --data-urlencode text="${message}"
        """
    }
}
